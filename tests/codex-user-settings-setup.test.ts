import { describe, expect, it, vi } from "vitest";

import { runCodexUserSettingsSetup } from "../scripts/codex-user-settings-setup.mjs";
import type { CodexUserSettingsState } from "../scripts/codex-user-settings-management.mjs";

describe("Codex user settings setup", () => {
  it.each([
    { value: null, hint: "当前：未设置" },
    { value: "user" as const, hint: "当前：手动审批" },
    { value: "auto_review" as const, hint: "当前：自动审查" },
  ])("distinguishes the Codex default approval preference: $value", async ({ value, hint }) => {
    const select = vi.fn(async () => "back");
    const updateSetting = vi.fn();
    await runCodexUserSettingsSetup({
      environment: {}, output: { write: () => undefined }, updateSetting,
      loadSettings: async () => ({ ...settingsState(), approvalsReviewer: { value, editable: true } }),
      prompts: { select, confirm: vi.fn(), isCancel: () => false },
    });
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ options: expect.arrayContaining([
      expect.objectContaining({ value: "approvals-reviewer", label: "Codex 默认审批方式", hint }),
    ]) }));
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it.each([true, false])("writes Auto-review only after explicit confirmation: %s", async (confirmed) => {
    const updateSetting = vi.fn(async () => ({ kind: "approvals-reviewer" as const, previousVersion: "version-1", value: { value: "auto_review" }, activation: "next-thread" as const }));
    await runCodexUserSettingsSetup({
      environment: {}, output: { write: () => undefined }, loadSettings: async () => settingsState(), updateSetting,
      prompts: { select: vi.fn().mockResolvedValueOnce("approvals-reviewer").mockResolvedValueOnce("auto_review"), confirm: async () => confirmed, isCancel: () => false },
    });
    if (confirmed) expect(updateSetting).toHaveBeenCalledWith({ kind: "approvals-reviewer", value: "auto_review" }, expect.objectContaining({ expectedVersion: "version-1" }));
    else expect(updateSetting).not.toHaveBeenCalled();
  });

  it.each(["managed-policy", "unavailable"] as const)("does not prompt or write a read-only reviewer setting: %s", async (reason) => {
    const updateSetting = vi.fn();
    const confirm = vi.fn();
    const select = vi.fn(async () => "approvals-reviewer");
    const write = vi.fn();
    await runCodexUserSettingsSetup({
      environment: {}, output: { write }, updateSetting,
      loadSettings: async () => ({ ...settingsState(), approvalsReviewer: { value: null, editable: false, reason } }),
      prompts: { select, confirm, isCancel: () => false },
    });
    expect(select).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(updateSetting).not.toHaveBeenCalled();
    if (reason === "unavailable") {
      expect(write).toHaveBeenCalledWith(expect.stringContaining("审批策略暂不可用"));
      expect(write).toHaveBeenCalledWith(expect.stringContaining("其他 Codex 用户设置仍可使用"));
    }
  });

  it.each(["subagents", "back"])("opens optional subagent setup only on explicit selection: %s", async (section) => {
    const subagentsSetup = vi.fn(async () => ({ action: "back" as const }));
    const updateSetting = vi.fn();
    const environment = {};
    const output = { write: () => undefined };
    const prompts = { select: vi.fn(async () => section), confirm: vi.fn(), isCancel: () => false };
    await runCodexUserSettingsSetup({
      environment, output, prompts, subagentsSetup, updateSetting,
      loadSettings: async () => settingsState(),
    });
    if (section === "subagents") {
      expect(subagentsSetup).toHaveBeenCalledWith({ environment, output, prompts, createClient: undefined });
    } else {
      expect(subagentsSetup).not.toHaveBeenCalled();
    }
    expect(updateSetting).not.toHaveBeenCalled();
  });

  it("allows other menu settings while the reviewer policy is unavailable", async () => {
    const updateSetting = vi.fn(async () => ({ kind: "fast" as const, previousVersion: "version-1", value: { enabled: true }, activation: "next-thread" as const }));
    const select = vi.fn().mockResolvedValueOnce("fast").mockResolvedValueOnce(true);
    await runCodexUserSettingsSetup({
      environment: {}, output: { write: () => undefined }, updateSetting,
      loadSettings: async () => ({ ...settingsState(), approvalsReviewer: { value: "user", editable: false, reason: "unavailable" } }),
      prompts: { select, confirm: async () => true, isCancel: () => false },
    });
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ options: expect.arrayContaining([
      expect.objectContaining({ value: "approvals-reviewer", hint: "当前：只读，审批策略暂不可用" }),
      expect.objectContaining({ value: "fast" }),
    ]) }));
    expect(updateSetting).toHaveBeenCalledWith({ kind: "fast", enabled: true }, expect.objectContaining({ expectedVersion: "version-1" }));
  });

  it.each([
    { type: "number", invalid: ["30s", "-1", "0", "1e400", "false"], accepted: "30", value: 30 },
    { type: "integer", invalid: ["1.5", "0", "9007199254740992"], accepted: "2", value: 2 },
    { type: "list", invalid: ['[read]', '["read","read"]', '[""]', '[1]'], accepted: '["read"]', value: ["read"] },
    { type: "list", invalid: ["false"], accepted: "", value: null },
  ] as const)("validates $type input before confirmation and permits correction", async ({ type, invalid, accepted, value }) => {
    const state = settingsState();
    const path = ["mcp_servers", "sample", "tool_timeout_sec"];
    state.toolSettings = { mergedAvailable: true, fields: [{ path, label: "测试字段", type, options: null, userValue: null, mergedValue: null }] };
    const updateSetting = vi.fn(async () => ({ kind: "tool-access" as const, previousVersion: "version-1", value: {}, activation: "next-thread" as const }));
    const confirm = vi.fn(async () => true);
    await runCodexUserSettingsSetup({
      environment: {}, output: { write: () => undefined }, loadSettings: async () => state, updateSetting,
      prompts: {
        select: vi.fn().mockResolvedValueOnce("tool-access").mockResolvedValueOnce(0),
        text: async ({ validate }) => {
          expect(validate).toBeTypeOf("function");
          for (const input of invalid) {
            expect(validate?.(input)).toEqual(expect.any(String));
            expect(confirm).not.toHaveBeenCalled();
            expect(updateSetting).not.toHaveBeenCalled();
          }
          expect(validate?.(accepted)).toBeUndefined();
          return accepted;
        },
        confirm, isCancel: () => false,
      },
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(updateSetting).toHaveBeenCalledWith({ kind: "tool-access", path, value }, expect.objectContaining({ expectedVersion: "version-1" }));
  });

  it("allows cancelling tool text input without confirming or writing", async () => {
    const cancel = Symbol("cancel");
    const state = settingsState();
    state.toolSettings = { mergedAvailable: true, fields: [{ path: ["mcp_servers", "sample", "enabled_tools"], label: "工具列表", type: "list", options: null, userValue: null, mergedValue: null }] };
    const updateSetting = vi.fn();
    const confirm = vi.fn();
    await expect(runCodexUserSettingsSetup({
      environment: {}, output: { write: () => undefined }, loadSettings: async () => state, updateSetting,
      prompts: { select: vi.fn().mockResolvedValueOnce("tool-access").mockResolvedValueOnce(0), text: async () => cancel, confirm, isCancel: (value) => value === cancel },
    })).resolves.toEqual({ action: "back" });
    expect(confirm).not.toHaveBeenCalled();
    expect(updateSetting).not.toHaveBeenCalled();
  });
  it.each([true, false])("saves native tool policy only when confirmed: %s", async (confirmed) => {
    const updateSetting = vi.fn(async () => ({ kind: "tool-access" as const, previousVersion: "version-1", value: {}, activation: "next-thread" as const }));
    const state = settingsState();
    state.toolSettings = { mergedAvailable: true, fields: [{
      path: ["computer_use", "default_app_access"], label: "默认应用访问", type: "choice",
      options: ["allow", "deny"], userValue: null, mergedValue: "deny",
    }] };
    await runCodexUserSettingsSetup({
      environment: {}, output: { write: () => undefined }, loadSettings: async () => state, updateSetting,
      prompts: { select: vi.fn().mockResolvedValueOnce("tool-access").mockResolvedValueOnce(0).mockResolvedValueOnce('"deny"'), confirm: vi.fn(async () => confirmed), isCancel: () => false },
    });
    if (confirmed) expect(updateSetting).toHaveBeenCalledWith({ kind: "tool-access", path: ["computer_use", "default_app_access"], value: "deny" }, expect.objectContaining({ expectedVersion: "version-1" }));
    else expect(updateSetting).not.toHaveBeenCalled();
  });
  it.each([undefined, null, "auto", "concise", "detailed", "none"] as const)(
    "defaults an unset reasoning summary to none and preserves %s",
    async (reasoningSummary) => {
      const updateSetting = vi.fn(async () => ({
        kind: "preferences" as const,
        previousVersion: "version-1",
        value: {},
        activation: "next-thread-and-tui" as const,
      }));
      const prompts = {
        select: vi.fn(async (options: { initialValue?: unknown }) => options.initialValue)
          .mockResolvedValueOnce("preferences"),
        confirm: vi.fn(async () => true),
        isCancel: () => false,
      };

      await runCodexUserSettingsSetup({
        environment: {},
        output: { write: () => undefined },
        prompts,
        loadSettings: async () => {
          const state = settingsState();
          return {
            ...state,
            defaults: {
              ...state.defaults,
              ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
            },
          };
        },
        updateSetting,
      });

      expect(updateSetting).toHaveBeenCalledWith(expect.objectContaining({
        kind: "preferences",
        reasoningSummary: reasoningSummary ?? "none",
      }), expect.anything());
    },
  );

  it("writes every user default after one final confirmation", async () => {
    const output: string[] = [];
    const subagentsSetup = vi.fn();
    const updateSetting = vi.fn(async () => ({
      kind: "all" as const,
      previousVersion: "version-1",
      value: {},
      activation: "next-thread" as const,
    }));
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("all")
        .mockResolvedValueOnce("gpt-test")
        .mockResolvedValueOnce("medium")
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce("workspace-write")
        .mockResolvedValueOnce("on-request")
        .mockResolvedValueOnce(true),
      confirm: vi.fn(async () => true),
      isCancel: () => false,
    };

    await runCodexUserSettingsSetup({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      output: { write: (value: string) => output.push(value) },
      prompts,
      loadSettings: async () => settingsState(),
      updateSetting,
      subagentsSetup,
    });

    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(subagentsSetup).not.toHaveBeenCalled();
    expect(updateSetting).toHaveBeenCalledWith({
      kind: "all",
      model: "gpt-test",
      reasoningEffort: "medium",
      fastEnabled: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: true,
    }, {
      environment: { CODEX_HOME: "/tmp/codex-home" },
      expectedVersion: "version-1",
    });
    expect(output.join("")).toContain("Codex 核心默认值已更新");
  });

  it("updates all permission defaults from one preview", async () => {
    const output: string[] = [];
    const updateSetting = vi.fn(async () => ({
      kind: "permissions" as const,
      previousVersion: "version-1",
      value: {},
      activation: "next-thread" as const,
    }));
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("permissions")
        .mockResolvedValueOnce("workspace-write")
        .mockResolvedValueOnce("on-request")
        .mockResolvedValueOnce(true),
      confirm: vi.fn(async () => true),
      isCancel: () => false,
    };

    await runCodexUserSettingsSetup({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      output: { write: (value: string) => output.push(value) },
      prompts,
      loadSettings: async () => settingsState(),
      updateSetting,
    });

    expect(updateSetting).toHaveBeenCalledWith({
      kind: "permissions",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: true,
    }, {
      environment: { CODEX_HOME: "/tmp/codex-home" },
      expectedVersion: "version-1",
    });
    const approvalPrompt = prompts.select.mock.calls[2]?.[0] as {
      options?: Array<{ value: string }>;
    };
    expect(approvalPrompt.options?.map((option) => option.value)).toEqual([
      "on-request",
      "never",
      "back",
    ]);
    expect(output.join("")).toContain("Codex 用户权限已更新");
  });

  it("does not offer official defaults under a fixed third-party Provider", async () => {
    const prompts = {
      select: vi.fn(async (options: unknown) => {
        void options;
        return "back";
      }),
      confirm: vi.fn(),
      isCancel: () => false,
    };

    await expect(runCodexUserSettingsSetup({
      prompts,
      loadSettings: async () => ({
        ...settingsState(),
        provider: "deepseek",
        defaultsEditable: false,
        models: [],
      }),
    })).resolves.toEqual({ action: "back" });

    const firstCall = prompts.select.mock.calls[0]?.[0] as
      | { options?: Array<{ value: string }> }
      | undefined;
    const options = firstCall?.options ?? [];
    expect(options.map((option: { value: string }) => option.value)).toEqual([
      "web-search",
      "update-plan",
      "auto-recap",
      "permissions",
      "approvals-reviewer",
      "tool-access",
      "back",
    ]);
  });

  it("updates the upstream plan checklist tool setting", async () => {
    const output: string[] = [];
    const updateSetting = vi.fn(async () => ({
      kind: "update-plan" as const,
      previousVersion: "version-1",
      value: { enabled: true },
      activation: "next-thread" as const,
    }));
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("update-plan")
        .mockResolvedValueOnce("enabled"),
      confirm: vi.fn(async () => true),
      isCancel: () => false,
    };

    await runCodexUserSettingsSetup({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      output: { write: (value: string) => output.push(value) },
      prompts,
      loadSettings: async () => settingsState(),
      updateSetting,
    });

    expect(updateSetting).toHaveBeenCalledWith({
      kind: "update-plan",
      enabled: true,
    }, {
      environment: { CODEX_HOME: "/tmp/codex-home" },
      expectedVersion: "version-1",
    });
    expect(output.join("")).toContain("Codex 计划清单工具已开启");
  });

  it("updates automatic TUI recaps with disabled as the default", async () => {
    const output: string[] = [];
    const updateSetting = vi.fn(async () => ({
      kind: "auto-recap" as const,
      previousVersion: "version-1",
      value: { enabled: false },
      activation: "next-tui" as const,
    }));
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("auto-recap")
        .mockResolvedValueOnce("disabled"),
      confirm: vi.fn(async () => true),
      isCancel: () => false,
    };

    await runCodexUserSettingsSetup({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      output: { write: (value: string) => output.push(value) },
      prompts,
      loadSettings: async () => settingsState(),
      updateSetting,
    });

    expect(updateSetting).toHaveBeenCalledWith({
      kind: "auto-recap",
      enabled: false,
    }, {
      environment: { CODEX_HOME: "/tmp/codex-home" },
      expectedVersion: "version-1",
    });
    expect(output.join("")).toContain("Codex 空闲总结已关闭");
  });

  it("refuses to mix Permission Profiles with traditional sandbox fields", async () => {
    const output: string[] = [];
    const updateSetting = vi.fn();

    await expect(runCodexUserSettingsSetup({
      output: { write: (value: string) => output.push(value) },
      prompts: {
        select: vi.fn(async () => "permissions"),
        confirm: vi.fn(),
        isCancel: () => false,
      },
      loadSettings: async () => ({
        ...settingsState(),
        permissions: {
          editable: false,
          defaultPermissions: ":workspace",
          sandboxMode: null,
          approvalPolicy: null,
          networkAccess: null,
        },
      }),
      updateSetting,
    })).resolves.toEqual({ action: "back" });

    expect(updateSetting).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Permission Profile（:workspace）");
  });

  it("writes official model context window and auto compact after confirmation", async () => {
    const output: string[] = [];
    const updateSetting = vi.fn(async () => ({
      kind: "model-compact" as const,
      previousVersion: "version-1",
      value: { contextWindow: 100_000, autoCompactPercent: 40 },
      activation: "next-thread" as const,
    }));
    const prompts = {
      select: vi.fn(async () => "model-compact"),
      text: vi.fn()
        .mockResolvedValueOnce("100000")
        .mockResolvedValueOnce("40"),
      confirm: vi.fn(async () => true),
      isCancel: () => false,
    };

    await runCodexUserSettingsSetup({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      output: { write: (value: string) => output.push(value) },
      prompts,
      loadSettings: async () => settingsState(),
      updateSetting,
    });

    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(updateSetting).toHaveBeenCalledWith({
      kind: "model-compact",
      contextWindow: 100_000,
      autoCompactPercent: 40,
    }, {
      environment: { CODEX_HOME: "/tmp/codex-home" },
      expectedVersion: "version-1",
    });
    expect(output.join("")).toContain("Codex 模型上下文与自动压缩已更新");
  });
});

function settingsState(): CodexUserSettingsState {
  return {
    approvalsReviewer: { value: null, editable: true },
    toolSettings: { mergedAvailable: false, fields: [] },
    version: "version-1",
    provider: "openai",
    defaultsEditable: true,
    models: [{
      model: "gpt-test",
      displayName: "GPT Test",
      reasoningEfforts: [{ effort: "medium", description: "Balanced" }],
      defaultReasoningEffort: "medium",
      isDefault: true,
    }],
    defaults: {
      model: "gpt-test",
      reasoningEffort: "medium",
      fastEnabled: false,
      webSearch: null,
      updatePlanEnabled: false,
      autoRecapEnabled: false,
    },
    permissions: {
      editable: true,
      defaultPermissions: null,
      sandboxMode: null,
      approvalPolicy: null,
      networkAccess: null,
    },
    compact: {
      contextWindow: null,
      autoCompactPercent: null,
    },
  };
}
