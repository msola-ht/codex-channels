import { describe, expect, it, vi } from "vitest";

import type {
  CodexUserConfigClient,
  CodexUserConfigValue,
} from "../scripts/codex-user-config.mjs";
import {
  loadCodexUserSettings,
  updateCodexUserSetting,
} from "../scripts/codex-user-settings-management.mjs";

describe("Codex user settings management", () => {
  it("loads one redacted user-level settings snapshot", async () => {
    const client = settingsClient({
      model: "gpt-test",
      model_reasoning_effort: "high",
      service_tier: "fast",
      sandbox_mode: "workspace-write",
      approval_policy: "on-request",
      sandbox_workspace_write: {
        network_access: true,
        writable_roots: ["/private/root"],
      },
    });

    await expect(loadCodexUserSettings({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toEqual({
      version: "version-1",
      provider: "openai",
      defaultsEditable: true,
      models: [projectedModel()],
      defaults: {
        model: "gpt-test",
        reasoningEffort: "high",
        fastEnabled: true,
        webSearch: null,
        reasoningSummary: null,
        planModeReasoningEffort: null,
        verbosity: null,
        personality: null,
        checkForUpdateOnStartup: null,
        historyPersistence: null,
      },
      permissions: {
        editable: true,
        defaultPermissions: null,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        networkAccess: true,
      },
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("writes model and reasoning defaults in one versioned transaction", async () => {
    const client = settingsClient({ model: "gpt-test" });

    await expect(updateCodexUserSetting({
      kind: "defaults",
      model: "gpt-test",
      reasoningEffort: "high",
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toMatchObject({
      kind: "defaults",
      activation: "restart-all",
      value: { model: "gpt-test", reasoningEffort: "high" },
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model", value: "gpt-test" },
      { keyPath: "model_reasoning_effort", value: "high" },
    ], { expectedVersion: "version-1" });
  });

  it("writes every user default in one versioned transaction", async () => {
    const client = settingsClient({ model: "old-model" });

    await expect(updateCodexUserSetting({
      kind: "all",
      model: "gpt-test",
      reasoningEffort: "high",
      fastEnabled: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: true,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toMatchObject({
      kind: "all",
      activation: "restart-all",
      value: {
        model: "gpt-test",
        reasoningEffort: "high",
        fastEnabled: true,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        networkAccess: true,
        webSearch: "cached",
      },
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model", value: "gpt-test" },
      { keyPath: "model_reasoning_effort", value: "high" },
      { keyPath: "service_tier", value: "fast" },
      { keyPath: "sandbox_mode", value: "workspace-write" },
      { keyPath: "approval_policy", value: "on-request" },
      { keyPath: "sandbox_workspace_write.network_access", value: true },
      { keyPath: "web_search", value: "cached" },
      { keyPath: "analytics.enabled", value: false },
      { keyPath: "feedback.enabled", value: false },
      { keyPath: "features.goals", value: true },
    ], { expectedVersion: "version-1" });
  });

  it("writes the main Fast preference without consulting a third-party model catalog", async () => {
    const client = settingsClient({ model: "deepseek-v4" });

    await expect(updateCodexUserSetting({
      kind: "fast",
      enabled: true,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    })).resolves.toMatchObject({ kind: "fast", value: { enabled: true } });

    expect(client.listModels).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "service_tier", value: "fast" },
    ], { expectedVersion: "version-1" });
  });

  it("writes the selected web search mode in a separate setting", async () => {
    const client = settingsClient({ web_search: "cached" });

    await expect(updateCodexUserSetting({
      kind: "web-search",
      mode: "live",
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    })).resolves.toMatchObject({
      kind: "web-search",
      value: { mode: "live" },
      activation: "restart-all",
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "web_search", value: "live" },
    ], { expectedVersion: "version-1" });
  });

  it("writes additional user preferences in one versioned transaction", async () => {
    const client = settingsClient({});

    await expect(updateCodexUserSetting({
      kind: "preferences",
      reasoningSummary: "concise",
      planModeReasoningEffort: "high",
      verbosity: "high",
      personality: "friendly",
      checkForUpdateOnStartup: false,
      historyPersistence: "none",
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toMatchObject({
      kind: "preferences",
      activation: "restart-all",
    });

    expect(client.listModels).toHaveBeenCalledOnce();
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_reasoning_summary", value: "concise" },
      { keyPath: "plan_mode_reasoning_effort", value: "high" },
      { keyPath: "model_verbosity", value: "high" },
      { keyPath: "personality", value: "friendly" },
      { keyPath: "check_for_update_on_startup", value: false },
      { keyPath: "history.persistence", value: "none" },
    ], { expectedVersion: "version-1" });
  });

  it("writes sandbox, approval and network together without replacing other sandbox fields", async () => {
    const client = settingsClient({
      sandbox_workspace_write: { writable_roots: ["/preserved"] },
    });

    await updateCodexUserSetting({
      kind: "permissions",
      sandboxMode: "workspace-write",
      approvalPolicy: "untrusted",
      networkAccess: true,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    });

    expect(client.listModels).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "sandbox_mode", value: "workspace-write" },
      { keyPath: "approval_policy", value: "untrusted" },
      { keyPath: "sandbox_workspace_write.network_access", value: true },
    ], { expectedVersion: "version-1" });
  });

  it("fails closed when a Permission Profile already owns the permission model", async () => {
    const client = settingsClient({ default_permissions: ":workspace" });

    await expect(updateCodexUserSetting({
      kind: "permissions",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
    })).rejects.toMatchObject({
      code: "permission-profile-active",
      field: "sandboxMode",
    });
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("does not partially write all settings when a Permission Profile is active", async () => {
    const client = settingsClient({ default_permissions: ":workspace" });

    await expect(updateCodexUserSetting({
      kind: "all",
      model: "gpt-test",
      reasoningEffort: "high",
      fastEnabled: false,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: false,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).rejects.toMatchObject({ code: "permission-profile-active" });
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("rejects stale revisions before writing", async () => {
    const client = settingsClient({ model: "gpt-test" });

    await expect(updateCodexUserSetting({
      kind: "fast",
      enabled: true,
    }, {
      expectedVersion: "old-version",
      createClient: async () => client,
    })).rejects.toMatchObject({
      code: "stale-revision",
      field: "revision",
    });
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("maps an App Server write race to the same stable revision error", async () => {
    const client = settingsClient({ model: "gpt-test" });
    client.writeUserConfigEdits = vi.fn(async () => {
      throw Object.assign(new Error("version conflict"), {
        data: { config_write_error_code: "configVersionConflict" },
      });
    });

    await expect(updateCodexUserSetting({
      kind: "fast",
      enabled: true,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
    })).rejects.toMatchObject({
      code: "stale-revision",
      field: "revision",
    });
  });

  it("keeps official defaults unavailable under a fixed third-party Provider", async () => {
    const client = settingsClient({ model: "deepseek-v4" });

    await expect(updateCodexUserSetting({
      kind: "defaults",
      model: "gpt-test",
      reasoningEffort: "high",
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    })).rejects.toMatchObject({ code: "third-party-primary" });
  });
});

function settingsClient(
  config: Record<string, CodexUserConfigValue | undefined>,
): CodexUserConfigClient {
  return {
    connect: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    readUserConfigSnapshot: vi.fn(async () => ({ config, version: "version-1" })),
    listModels: vi.fn(async () => [modelOption()]),
    writeUserConfigEdits: vi.fn(async () => undefined),
    readDefaultModelSettings: vi.fn(),
    writeDefaultModelSettings: vi.fn(),
  };
}

function modelOption() {
  return {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    supportedReasoningEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deeper" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
    inputModalities: ["text"],
  };
}

function projectedModel() {
  return {
    model: "gpt-test",
    displayName: "GPT Test",
    reasoningEfforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "Deeper" },
    ],
    defaultReasoningEffort: "medium",
    isDefault: true,
  };
}
