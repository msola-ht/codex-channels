import { describe, expect, it } from "vitest";

import { loadModelProviderManagementState } from "../scripts/model-provider-management.mjs";

describe("model Provider management state", () => {
  it("combines managed, custom and agent state without returning credentials", async () => {
    const state = await loadModelProviderManagementState({
      environment: {},
      readUserConfig: async () => ({
        version: "v7",
        config: {
          model: "gpt-5.6-sol",
          model_reasoning_effort: "medium",
          model_provider: "codeproxy",
          model_providers: {
            codeproxy: {
              name: "Code Proxy",
              base_url: "https://proxy.example/v1",
              experimental_bearer_token: "fixed-secret",
            },
          },
        },
      }),
      listCustomCandidates: () => ["codeproxy"],
      readBackup: () => ({
        archived: {
          name: "Archived",
          base_url: "https://user:password@archive.example/v1",
        },
      }),
      loadManagedProviders: () => [{
        provider: "deepseek",
        displayName: "DeepSeek",
        model: "deepseek-v4-flash-vision-exp",
        reasoningEffort: "high",
        mode: "switching",
        models: [{
          model: "deepseek-v4-flash-vision-exp",
          displayName: "DeepSeek V4 Flash Vision",
          contextWindow: 1_000_000,
          reasoningEffort: "high",
          reasoningEfforts: [{ effort: "high", description: "高" }],
        }],
      }],
      loadCustomSwitchingProviders: () => [{
        id: "relay",
        name: "Relay\u001b Injected",
        model: "gpt-5.6-sol",
        reasoningEffort: "medium",
        baseUrl: "https://relay.example/v1",
        profileName: "custom-relay",
        apiKey: "switch-secret",
        profileContent: "secret-content",
      }],
      loadAgentStatus: () => ({
        externalRoleConfigured: true,
        provider: "deepseek",
        model: "deepseek-v4-flash-vision-exp",
      }),
    });

    expect(state).toMatchObject({
      configVersion: "v7",
      defaults: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      primary: {
        id: "codeproxy",
        displayName: "Code Proxy",
        kind: "custom",
        mode: "exclusive",
      },
      externalAgent: {
        status: "configured",
        provider: "deepseek",
      },
    });
    expect(state.switchingProviders.map((provider) => provider.id)).toEqual([
      "deepseek",
      "relay",
    ]);
    expect(state.customProviders.switchingProviders[0]?.displayName).toBe("Relay Injected");
    expect(state.customProviders.backupCandidates[0]?.baseUrl).toBe("");
    expect(JSON.stringify(state)).not.toMatch(/fixed-secret|switch-secret|secret-content|user:password/u);
  });
});
