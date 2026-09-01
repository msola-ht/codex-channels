import { describe, expect, it, vi } from "vitest";

import { runCodexUserSettingsSetup } from "../scripts/codex-user-settings-setup.mjs";
import type { CodexUserSettingsState } from "../scripts/codex-user-settings-management.mjs";

describe("Codex user settings setup", () => {
  it("writes every user default after one final confirmation", async () => {
    const output: string[] = [];
    const updateSetting = vi.fn(async () => ({
      kind: "all" as const,
      previousVersion: "version-1",
      value: {},
      activation: "restart-all" as const,
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
    });

    expect(prompts.confirm).toHaveBeenCalledOnce();
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
      activation: "restart-all" as const,
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
      "permissions",
      "back",
    ]);
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
});

function settingsState(): CodexUserSettingsState {
  return {
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
    },
    permissions: {
      editable: true,
      defaultPermissions: null,
      sandboxMode: null,
      approvalPolicy: null,
      networkAccess: null,
    },
  };
}
