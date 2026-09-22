import { describe, expect, it, vi } from "vitest";

import type {
  CodexUserConfigClient,
  CodexUserConfigValue,
} from "../scripts/codex-user-config.mjs";
import {
  loadCodexUserSettings,
  previewCodexUserSetting,
  updateCodexUserSetting,
} from "../scripts/codex-user-settings-management.mjs";

describe("Codex user settings management", () => {
  it("projects native policy separately from merged config without exposing MCP secrets", async () => {
    const config = {
      computer_use: { default_app_access: "allow" },
      mcp_servers: { test: { command: "private-command", env: { TOKEN: "private-token" }, tool_timeout_sec: 20 } },
      plugins: { "use@bundled": { mcp_servers: { cua: { enabled: true } } } },
    };
    const client = settingsClient(config);
    vi.mocked(client.readUserConfigSnapshot).mockResolvedValue({ config, version: "version-1", toolConfig: {
      ...config, computer_use: { default_app_access: "deny" },
    } });
    const state = await loadCodexUserSettings({ createClient: async () => client, primaryProvider: () => "openai" });
    expect(state.toolSettings.fields[0]).toMatchObject({ userValue: "allow", mergedValue: "deny" });
    expect(JSON.stringify(state.toolSettings)).not.toContain("private-");
    expect(state.toolSettings.fields.some((field) => field.path[0] === "plugins" && field.path.includes("tool_timeout_sec"))).toBe(false);
  });

  it.each(["deny", null])("writes only a quoted application key with value %s", async (value) => {
    const client = settingsClient({ computer_use: { macos: { bundle_ids: { "com.example.App": "allow" } } } });
    const path = ["computer_use", "macos", "bundle_ids", "com.example.App"];
    const dependencies = { createClient: async () => client, primaryProvider: () => "openai", expectedVersion: "version-1" };
    await previewCodexUserSetting({ kind: "tool-access", path, value }, dependencies);
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
    await updateCodexUserSetting({ kind: "tool-access", path, value }, dependencies);
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: '"computer_use"."macos"."bundle_ids"."com.example.App"', value },
    ], { expectedVersion: "version-1" });
  });

  it.each([
    { path: ["mcp_servers", "test", "command"], value: "unsafe" },
    { path: ["plugins", "use@bundled", "mcp_servers", "cua", "tool_timeout_sec"], value: 30 },
    { path: ["mcp_servers", "test", "tool_timeout_sec"], value: -1 },
    { path: ["mcp_servers", "test", "enabled_tools"], value: ["read", "read"] },
    { path: ["computer_use", "default_app_access"], value: "approve" },
  ])("rejects unsupported or invalid tool settings: $path", async ({ path, value }) => {
    const client = settingsClient({ mcp_servers: { test: { command: "node" } }, plugins: { "use@bundled": { mcp_servers: { cua: {} } } } });
    await expect(updateCodexUserSetting({ kind: "tool-access", path, value }, {
      createClient: async () => client, primaryProvider: () => "openai", expectedVersion: "version-1",
    })).rejects.toMatchObject({ name: "CodexUserSettingsError" });
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

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
      toolSettings: expect.objectContaining({ mergedAvailable: false }),
      defaultsEditable: true,
      models: [projectedModel()],
      defaults: {
        model: "gpt-test",
        reasoningEffort: "high",
        fastEnabled: true,
        webSearch: null,
        updatePlanEnabled: false,
        autoRecapEnabled: false,
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
      compact: {
        contextWindow: null,
        autoCompactPercent: null,
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
      activation: "next-thread",
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
      activation: "next-thread",
      value: {
        model: "gpt-test",
        reasoningEffort: "high",
        fastEnabled: true,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        networkAccess: true,
      },
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model", value: "gpt-test" },
      { keyPath: "model_reasoning_effort", value: "high" },
      { keyPath: "service_tier", value: "fast" },
      { keyPath: "sandbox_mode", value: "workspace-write" },
      { keyPath: "approval_policy", value: "on-request" },
      { keyPath: "sandbox_workspace_write.network_access", value: true },
    ], { expectedVersion: "version-1" });
  });

  it("rejects Fast changes for a fixed third-party Provider", async () => {
    const client = settingsClient({ model: "deepseek-v4" });

    await expect(updateCodexUserSetting({
      kind: "fast",
      enabled: true,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    })).rejects.toMatchObject({ code: "third-party-primary", field: "provider" });

    expect(client.listModels).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
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
      activation: "next-thread",
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
      activation: "next-thread-and-tui",
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

  it("does not echo unknown preference fields in a preview", async () => {
    const client = settingsClient({});

    const input = {
      kind: "preferences",
      reasoningSummary: "concise",
      planModeReasoningEffort: "high",
      verbosity: "high",
      personality: "friendly",
      checkForUpdateOnStartup: false,
      historyPersistence: "none",
      apiKey: "must-not-echo",
    } as unknown as Parameters<typeof previewCodexUserSetting>[0];

    await expect(previewCodexUserSetting(input, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toMatchObject({
      value: expect.not.objectContaining({ apiKey: "must-not-echo" }),
    });
  });

  it.each([
    ["preview", previewCodexUserSetting],
    ["update", updateCodexUserSetting],
  ] as const)("rejects removed context management in %s without writing config", async (_name, operation) => {
    const client = settingsClient({});
    const input = { kind: "context-management", enabled: true } as unknown as Parameters<typeof operation>[0];

    await expect(operation(input, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    })).rejects.toMatchObject({ code: "unknown-setting", field: "kind" });
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
  });

  it("writes the upstream plan checklist tool setting separately", async () => {
    const client = settingsClient({ tools: { update_plan: { enabled: false } } });

    await expect(updateCodexUserSetting({
      kind: "update-plan",
      enabled: true,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    })).resolves.toMatchObject({
      kind: "update-plan",
      value: { enabled: true },
      activation: "next-thread",
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "tools.update_plan.enabled", value: true },
    ], { expectedVersion: "version-1" });
  });

  it("writes the TUI automatic recap setting separately", async () => {
    const client = settingsClient({ tui: { auto_recap: true } });

    await expect(updateCodexUserSetting({
      kind: "auto-recap",
      enabled: false,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    })).resolves.toMatchObject({
      kind: "auto-recap",
      value: { enabled: false },
      activation: "next-tui",
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "tui.auto_recap", value: false },
    ], { expectedVersion: "version-1" });
  });

  it("writes sandbox, approval and network together without replacing other sandbox fields", async () => {
    const client = settingsClient({
      sandbox_workspace_write: { writable_roots: ["/preserved"] },
    });

    await updateCodexUserSetting({
      kind: "permissions",
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
      networkAccess: true,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "deepseek",
    });

    expect(client.listModels).not.toHaveBeenCalled();
    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "sandbox_mode", value: "workspace-write" },
      { keyPath: "approval_policy", value: "on-request" },
      { keyPath: "sandbox_workspace_write.network_access", value: true },
    ], { expectedVersion: "version-1" });
  });

  it("rejects the retired untrusted policy before writing user config", async () => {
    const client = settingsClient({});

    await expect(updateCodexUserSetting({
      kind: "permissions",
      sandboxMode: "workspace-write",
      approvalPolicy: "untrusted" as never,
      networkAccess: false,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).rejects.toMatchObject({
      code: "invalid-approval-policy",
      field: "approvalPolicy",
    });
    expect(client.writeUserConfigEdits).not.toHaveBeenCalled();
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
      primaryProvider: () => "openai",
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
      primaryProvider: () => "openai",
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
      primaryProvider: () => "openai",
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

  it("writes official model context window and auto compact limit in one transaction", async () => {
    const client = settingsClient({ model: "gpt-test" });

    await expect(updateCodexUserSetting({
      kind: "model-compact",
      contextWindow: 100_000,
      autoCompactPercent: 40,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toMatchObject({
      kind: "model-compact",
      activation: "next-thread",
      value: { contextWindow: 100_000, autoCompactPercent: 40 },
    });

    expect(client.writeUserConfigEdits).toHaveBeenCalledWith([
      { keyPath: "model_context_window", value: 100_000 },
      { keyPath: "model_auto_compact_token_limit", value: 40_000 },
    ], { expectedVersion: "version-1" });
  });

  it("rejects compression percent without a context window", async () => {
    const client = settingsClient({ model: "gpt-test" });

    await expect(updateCodexUserSetting({
      kind: "model-compact",
      contextWindow: null,
      autoCompactPercent: 40,
    }, {
      expectedVersion: "version-1",
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).rejects.toMatchObject({ code: "window-required", field: "contextWindow" });
  });

  it("projects an existing model context window and auto compact percent", async () => {
    const client = settingsClient({
      model: "gpt-test",
      model_context_window: 200_000,
      model_auto_compact_token_limit: 80_000,
    });

    await expect(loadCodexUserSettings({
      environment: { CODEX_HOME: "/tmp/codex-home" },
      createClient: async () => client,
      primaryProvider: () => "openai",
    })).resolves.toMatchObject({
      compact: { contextWindow: 200_000, autoCompactPercent: 40 },
    });
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
