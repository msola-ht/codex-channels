import { describe, expect, it, vi } from "vitest";

import type { ManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import {
  ModelProviderDefaultManagementError,
  applyManagedProviderDefaultChange,
  previewManagedProviderDefaultChange,
} from "../scripts/model-provider-default-management.mjs";

describe("managed model Provider default management", () => {
  it("returns a prompt-free preview with the exact activation action", () => {
    expect(previewManagedProviderDefaultChange({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
    }, {
      environment: {},
      loadProviders: switchingProviders,
    })).toEqual({
      provider: { id: "deepseek", displayName: "DeepSeek", mode: "switching" },
      model: {
        id: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1_048_576,
      },
      reasoningEffort: "max",
      autoCompactPercent: 75,
      autoCompactLimit: 786_432,
      willChange: true,
      activation: "restart-app-server",
    });
  });

  it.each([
    [
      { provider: "deepseek", model: "missing", reasoningEffort: "high", autoCompactPercent: 60 },
      "model-not-supported",
      "model",
    ],
    [
      { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "ultra", autoCompactPercent: 60 },
      "reasoning-effort-not-supported",
      "reasoningEffort",
    ],
    [
      { provider: "deepseek", model: "deepseek-v4-pro", reasoningEffort: "max", autoCompactPercent: 91 },
      "invalid-auto-compact-percent",
      "autoCompactPercent",
    ],
  ])("returns stable validation errors for managed Provider defaults", (input, code, field) => {
    try {
      previewManagedProviderDefaultChange(input, {
        environment: {},
        loadProviders: switchingProviders,
      });
      throw new Error("expected managed Provider preview validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderDefaultManagementError);
      expect(error).toMatchObject({ code, field });
    }
  });

  it("applies a switching Provider change through the profile writer", async () => {
    const writeProfileDefault = vi.fn(() => ({
      provider: "deepseek" as const,
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactLimit: 786_432,
      mode: "switching" as const,
    }));

    const result = await applyManagedProviderDefaultChange({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
    }, {
      environment: {},
      loadProviders: switchingProviders,
      writeProfileDefault,
    });

    expect(result).toMatchObject({
      action: "updated",
      activation: "restart-app-server",
      autoCompactLimit: 786_432,
    });
    expect(writeProfileDefault).toHaveBeenCalledWith(
      "deepseek",
      {
        model: "deepseek-v4-pro",
        reasoningEffort: "max",
        autoCompactLimit: 786_432,
      },
      {},
    );
  });

  it("restores the catalog when an exclusive config transaction fails", async () => {
    const previous = {
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindow: 1_048_576,
      reasoningEffort: "high",
      reasoningEfforts: [{ effort: "high", description: "High" }],
      autoCompactLimit: 629_146,
      autoCompactPercent: 60,
    };
    const writeCatalogSettings = vi.fn()
      .mockReturnValueOnce(previous)
      .mockReturnValueOnce(previous);

    await expect(applyManagedProviderDefaultChange({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
    }, {
      environment: {},
      loadProviders: exclusiveProviders,
      writeCatalogSettings,
      writeConfigEdits: vi.fn(async () => { throw new Error("version conflict"); }),
    })).rejects.toMatchObject({
      code: "operation-failed",
      field: "action",
      message: "version conflict",
    });
    expect(writeCatalogSettings).toHaveBeenNthCalledWith(
      2,
      "deepseek",
      previous,
      {},
    );
  });
});

function switchingProviders(): ManagedModelProviderSettings[] {
  return providers("switching");
}

function exclusiveProviders(): ManagedModelProviderSettings[] {
  return providers("exclusive");
}

function providers(mode: "switching" | "exclusive"): ManagedModelProviderSettings[] {
  return [{
    provider: "deepseek",
    displayName: "DeepSeek",
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    mode,
    models: [{
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1_048_576,
      reasoningEffort: "high",
      reasoningEfforts: [
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
      autoCompactLimit: 629_146,
      autoCompactPercent: 60,
    }],
  }];
}
