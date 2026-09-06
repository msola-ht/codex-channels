import { describe, expect, it, vi } from "vitest";

import {
  ModelCompressionManagementError,
  applyModelCompressionChange,
  previewModelCompressionChange,
  projectModelCompression,
} from "../scripts/model-compression-management.mjs";
import { fingerprintManagementValue } from "../scripts/management-security.mjs";

describe("model compression management", () => {
  it("previews a compression change with an exact activation action", () => {
    expect(previewModelCompressionChange({
      model: "deepseek-v4-flash",
      autoCompactPercent: 75,
    }, {
      environment: {},
      loadCompression: () => compressionModels(),
    })).toEqual({
      model: {
        id: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1_048_576,
      },
      autoCompactPercent: 75,
      autoCompactLimit: 786_432,
      providers: ["deepseek", "opencode-go"],
      willChange: true,
      conflicts: false,
      windowConflict: false,
      overridden: [{ provider: "deepseek", previousPercent: 40 }],
      activation: "restart-app-server",
    });
  });

  it("reports no change when the compression already matches", () => {
    expect(previewModelCompressionChange({
      model: "deepseek-v4-flash",
      autoCompactPercent: 40,
    }, {
      environment: {},
      loadCompression: () => [
        { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 1_048_576, autoCompactPercent: 40, providers: ["deepseek"], perProvider: { deepseek: 40 }, conflicts: false },
      ],
    }).willChange).toBe(false);
  });

  it("exposes conflicting per-Provider values and the overridden targets before applying", () => {
    const result = previewModelCompressionChange({
      model: "deepseek-v4-flash",
      autoCompactPercent: 50,
    }, {
      environment: {},
      loadCompression: () => [
        { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 1_048_576, autoCompactPercent: 40, providers: ["deepseek", "opencode-go"], perProvider: { deepseek: 40, "opencode-go": 60 }, conflicts: true },
      ],
    });
    expect(result.conflicts).toBe(true);
    expect(result.overridden).toEqual([
      { provider: "deepseek", previousPercent: 40 },
      { provider: "opencode-go", previousPercent: 60 },
    ]);
  });

  it("fails closed when the same model has inconsistent context windows across providers", () => {
    try {
      previewModelCompressionChange({
        model: "deepseek-v4-flash",
        autoCompactPercent: 40,
      }, {
        environment: {},
        loadCompression: () => [
          { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 1_048_576, autoCompactPercent: 40, providers: ["deepseek", "opencode-go"], perProvider: { deepseek: 40, "opencode-go": 40 }, conflicts: false, windowConflict: true },
        ],
      });
      throw new Error("expected model compression preview validation to fail on window conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCompressionManagementError);
      expect(error).toMatchObject({ code: "window-conflict", field: "model" });
    }
  });

  it.each([
    [{ model: "missing", autoCompactPercent: 40 }, "model-not-supported", "model"],
    [{ model: "deepseek-v4-flash", autoCompactPercent: 5 }, "invalid-auto-compact-percent", "autoCompactPercent"],
    [{ model: "", autoCompactPercent: 40 }, "required", "model"],
  ])("returns stable validation errors", (input, code, field) => {
    try {
      previewModelCompressionChange(input, {
        environment: {},
        loadCompression: () => compressionModels(),
      });
      throw new Error("expected model compression preview validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCompressionManagementError);
      expect(error).toMatchObject({ code, field });
    }
  });

  it("applies the compression globally across all providers", async () => {
    const writeCompression = vi.fn(() => ({
      model: "deepseek-v4-flash",
      autoCompactPercent: 40,
      autoCompactLimit: 419_430,
      providers: ["deepseek", "opencode-go"],
    }));
    const result = await applyModelCompressionChange({
      model: "deepseek-v4-flash",
      autoCompactPercent: 40,
    }, {
      environment: {},
      loadCompression: () => compressionModels(),
      writeCompression,
      withFileLock: withoutFileLock,
    });
    expect(result).toMatchObject({
      action: "updated",
      autoCompactPercent: 40,
      autoCompactLimit: 419_430,
      providers: ["deepseek", "opencode-go"],
    });
    expect(writeCompression).toHaveBeenCalledWith({
      model: "deepseek-v4-flash",
      autoCompactPercent: 40,
      environment: {},
    });
  });

  it("wraps the global write in a provider management transaction", async () => {
    const writeCompression = vi.fn(() => ({
      model: "deepseek-v4-flash",
      autoCompactPercent: 40,
      autoCompactLimit: 419_430,
      providers: ["deepseek", "opencode-go"],
    }));
    await applyModelCompressionChange({
      model: "deepseek-v4-flash",
      autoCompactPercent: 40,
    }, {
      environment: {},
      loadCompression: () => compressionModels(),
      writeCompression,
      withFileLock: withoutFileLock,
    });
    expect(writeCompression).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a provider has not been configured", () => {
    expect(() => previewModelCompressionChange({
      model: "deepseek-v4-flash",
      autoCompactPercent: 40,
    }, {
      environment: {},
      loadCompression: () => [],
    })).toThrow();
  });

  it("projects unset compression values as JSON-safe resource fields", () => {
    const projected = projectModelCompression([
      {
        model: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 1_048_576,
        autoCompactPercent: 40,
        providers: ["deepseek", "ocg-lunare"],
        perProvider: { deepseek: 40, "ocg-lunare": undefined },
        conflicts: false,
      },
      {
        model: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1_048_576,
        providers: ["deepseek", "ocg-lunare"],
        perProvider: { deepseek: undefined, "ocg-lunare": undefined },
        conflicts: false,
      },
    ]);
    expect(projected[0]?.perProvider).toEqual({ deepseek: 40 });
    expect(projected[0]?.autoCompactPercent).toBe(40);
    expect(projected[1]?.perProvider).toEqual({});
    expect(projected[1]).not.toHaveProperty("autoCompactPercent");
    expect(() => fingerprintManagementValue(projected)).not.toThrow();
  });
});

function compressionModels() {
  return [
    {
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindow: 1_048_576,
      autoCompactPercent: 40,
      providers: ["deepseek", "opencode-go"],
      perProvider: { deepseek: 40, "opencode-go": undefined },
      conflicts: false,
      windowConflict: false,
    },
    {
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1_048_576,
      providers: ["deepseek"],
    },
  ];
}

const withoutFileLock = async <T>(
  _path: string,
  operation: () => T | Promise<T>,
): Promise<T> => operation();
