import { describe, expect, it, vi } from "vitest";

import { runCodexDefaultsSetup } from "../scripts/codex-defaults-setup.mjs";
import type { CodexUserSettingsState } from "../scripts/codex-user-settings-management.mjs";

describe("Codex official defaults setup", () => {
  it("writes the selected official model and supported reasoning effort together", async () => {
    const output: string[] = [];
    const loadSettings = vi.fn(async () => settingsState());
    const updateSetting = vi.fn(async () => ({
      kind: "defaults" as const,
      previousVersion: "version-1",
      value: { model: "gpt-test", reasoningEffort: "high" },
      activation: "restart-all" as const,
    }));
    const prompts = {
      select: vi.fn()
        .mockResolvedValueOnce("gpt-test")
        .mockResolvedValueOnce("high"),
      confirm: vi.fn(async () => true),
      isCancel: () => false,
    };

    await expect(runCodexDefaultsSetup({
      output: { write: (value: string) => output.push(value) },
      prompts,
      environment: { CODEX_HOME: "/tmp/codex-home" },
      loadSettings,
      updateSetting,
    })).resolves.toEqual({ model: "gpt-test", effort: "high" });

    expect(updateSetting).toHaveBeenCalledWith({
      kind: "defaults",
      model: "gpt-test",
      reasoningEffort: "high",
    }, expect.objectContaining({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      expectedVersion: "version-1",
    }));
    expect(output.join("")).toContain("Codex 全局默认设置已更新");
    expect(output.join("")).toContain("codexc service restart all");
  });

  it("does not write global defaults when the user rejects the final confirmation", async () => {
    const updateSetting = vi.fn();
    const output: string[] = [];

    await expect(runCodexDefaultsSetup({
      output: { write: (value: string) => output.push(value) },
      prompts: {
        select: vi.fn()
          .mockResolvedValueOnce("gpt-test")
          .mockResolvedValueOnce("medium"),
        confirm: vi.fn(async () => false),
        isCancel: () => false,
      },
      loadSettings: async () => settingsState(),
      updateSetting,
    })).resolves.toBeUndefined();

    expect(updateSetting).not.toHaveBeenCalled();
    expect(output.join("")).toContain("未修改 Codex 全局配置");
  });

  it("rejects official defaults setup while a third-party provider is the fixed primary", async () => {
    const updateSetting = vi.fn();

    await expect(runCodexDefaultsSetup({
      loadSettings: async () => ({
        ...settingsState(),
        provider: "deepseek",
        defaultsEditable: false,
        models: [],
      }),
      updateSetting,
    })).rejects.toThrow("第三方固定模式（deepseek）");

    expect(updateSetting).not.toHaveBeenCalled();
  });

  it("names the actual provider when OpenCode Go is the fixed primary", async () => {
    await expect(runCodexDefaultsSetup({
      loadSettings: async () => ({
        ...settingsState(),
        provider: "opencode-go",
        defaultsEditable: false,
        models: [],
      }),
    })).rejects.toThrow("第三方固定模式（opencode-go）");
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
      reasoningEfforts: [
        { effort: "medium", description: "Balanced" },
        { effort: "high", description: "Deeper reasoning" },
      ],
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
