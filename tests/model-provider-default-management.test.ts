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
      withFileLock: withoutFileLock,
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
    const readConfigSnapshot = vi.fn(async () => ({
      config: { model: "deepseek-v4-flash" },
      version: "v1",
    }));
    const writeConfigEdits = vi.fn(async () => { throw new Error("version conflict"); });

    await expect(applyManagedProviderDefaultChange({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
    }, {
      environment: {},
      loadProviders: exclusiveProviders,
      writeCatalogSettings,
      readConfigSnapshot,
      writeConfigEdits,
      withFileLock: withoutFileLock,
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
    expect(writeConfigEdits).toHaveBeenCalledWith(
      {},
      expect.any(Array),
      { expectedVersion: "v1" },
    );
  });

  it("keeps the new catalog when the config write succeeded but its response was lost", async () => {
    const writeCatalogSettings = vi.fn().mockReturnValue({ model: "deepseek-v4-flash" });
    const readConfigSnapshot = vi.fn()
      .mockResolvedValueOnce({ config: { model: "deepseek-v4-flash" }, version: "v1" })
      .mockResolvedValueOnce({ config: { model: "deepseek-v4-pro" }, version: "v2" });

    await expect(applyManagedProviderDefaultChange({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
    }, {
      environment: {},
      loadProviders: exclusiveProviders,
      writeCatalogSettings,
      readConfigSnapshot,
      writeConfigEdits: vi.fn(async () => { throw new Error("response lost"); }),
      withFileLock: withoutFileLock,
    })).resolves.toMatchObject({ action: "updated", model: { id: "deepseek-v4-pro" } });
    expect(writeCatalogSettings).toHaveBeenCalledTimes(1);
  });

  it("does not roll back the catalog when the config write result cannot be confirmed", async () => {
    const writeCatalogSettings = vi.fn().mockReturnValue({ model: "deepseek-v4-flash" });
    const readConfigSnapshot = vi.fn()
      .mockResolvedValueOnce({ config: { model: "deepseek-v4-flash" }, version: "v1" })
      .mockRejectedValueOnce(new Error("confirmation unavailable"));

    await expect(applyManagedProviderDefaultChange({
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
    }, {
      environment: {},
      loadProviders: exclusiveProviders,
      writeCatalogSettings,
      readConfigSnapshot,
      writeConfigEdits: vi.fn(async () => { throw new Error("response lost"); }),
      withFileLock: withoutFileLock,
    })).rejects.toMatchObject({
      code: "operation-failed",
      message: "Codex 配置写入结果无法确认，模型目录保持新设置",
    });
    expect(writeCatalogSettings).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent catalog and Codex config transactions", async () => {
    const environment = {
      CODEX_CONNECT_HOME: mkdtempSync(join(tmpdir(), "codexc-model-settings-lock-")),
    };
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    const loadProviders = vi.fn(exclusiveProviders);
    let writeCalls = 0;
    const writeConfigEdits = vi.fn(async () => {
      writeCalls += 1;
      if (writeCalls === 1) {
        markFirstEntered();
        await firstMayFinish;
      }
    });
    const options = {
      environment,
      loadProviders,
      writeCatalogSettings: vi.fn(() => exclusiveProviders()[0]!.models[0]!),
      readConfigSnapshot: vi.fn(async () => ({
        config: { model: "deepseek-v4-flash" },
        version: "v1",
      })),
      writeConfigEdits,
    };
    const input = {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
    };

    const first = applyManagedProviderDefaultChange(input, options);
    await firstEntered;
    const second = applyManagedProviderDefaultChange(input, options);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(loadProviders).toHaveBeenCalledTimes(1);
    expect(writeConfigEdits).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(loadProviders).toHaveBeenCalledTimes(2);
    expect(writeConfigEdits).toHaveBeenCalledTimes(2);
  });
});

const withoutFileLock = async <T>(
  _path: string,
  operation: () => T | Promise<T>,
): Promise<T> => operation();

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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
