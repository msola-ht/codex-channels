import { describe, expect, it, vi } from "vitest";

import {
  ModelWindowManagementError,
  applyModelWindowChange,
  previewModelWindowChange,
  projectModelWindow,
} from "../scripts/model-window-management.mjs";
import { fingerprintManagementValue } from "../scripts/management-security.mjs";

describe("model window management", () => {
  it("previews a window change with an exact activation action", () => {
    expect(previewModelWindowChange({
      model: "deepseek-v4-flash",
      windowPercent: 75,
    }, {
      environment: {},
      loadWindow: () => windowModels(),
    })).toEqual({
      model: {
        id: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 419_430,
        maxContextWindow: 1_048_576,
      },
      windowPercent: 75,
      contextWindow: 786_432,
      providers: ["deepseek", "opencode-go"],
      willChange: true,
      conflicts: false,
      windowConflict: false,
      overridden: [{ provider: "deepseek", previousPercent: 40 }],
      activation: "restart-app-server",
    });
  });

  it("reports no change when the window already matches", () => {
    expect(previewModelWindowChange({
      model: "deepseek-v4-flash",
      windowPercent: 40,
    }, {
      environment: {},
      loadWindow: () => [
        { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 419_430, maxContextWindow: 1_048_576, windowPercent: 40, providers: ["deepseek"], perProvider: { deepseek: 40 }, conflicts: false },
      ],
    }).willChange).toBe(false);
  });

  it("exposes conflicting per-Provider values and the overridden targets before applying", () => {
    const result = previewModelWindowChange({
      model: "deepseek-v4-flash",
      windowPercent: 40,
    }, {
      environment: {},
      loadWindow: () => [
        { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 419_430, maxContextWindow: 1_048_576, windowPercent: 40, providers: ["deepseek", "opencode-go"], perProvider: { deepseek: 40, "opencode-go": 60 }, conflicts: true },
      ],
    });
    expect(result.conflicts).toBe(true);
    expect(result.willChange).toBe(true);
    expect(result.overridden).toEqual([
      { provider: "opencode-go", previousPercent: 60 },
    ]);
  });

  it("fails closed when the same model has inconsistent maximum windows across providers", () => {
    try {
      previewModelWindowChange({
        model: "deepseek-v4-flash",
        windowPercent: 40,
      }, {
        environment: {},
        loadWindow: () => [
          { model: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 419_430, maxContextWindow: 1_048_576, windowPercent: 40, providers: ["deepseek", "opencode-go"], perProvider: { deepseek: 40, "opencode-go": 40 }, conflicts: false, windowConflict: true },
        ],
      });
      throw new Error("expected model window preview validation to fail on window conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelWindowManagementError);
      expect(error).toMatchObject({ code: "window-conflict", field: "model" });
    }
  });

  it.each([
    [{ model: "missing", windowPercent: 40 }, "model-not-supported", "model"],
    [{ model: "deepseek-v4-flash", windowPercent: 5 }, "invalid-window-percent", "windowPercent"],
    [{ model: "", windowPercent: 40 }, "required", "model"],
  ])("returns stable validation errors", (input, code, field) => {
    try {
      previewModelWindowChange(input, {
        environment: {},
        loadWindow: () => windowModels(),
      });
      throw new Error("expected model window preview validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelWindowManagementError);
      expect(error).toMatchObject({ code, field });
    }
  });

  it("applies the window globally across all providers", async () => {
    const writeWindow = vi.fn(() => ({
      model: "deepseek-v4-flash",
      windowPercent: 40,
      contextWindow: 419_430,
      providers: ["deepseek", "opencode-go"],
      overridden: [],
    }));
    const result = await applyModelWindowChange({
      model: "deepseek-v4-flash",
      windowPercent: 40,
    }, {
      environment: {},
      loadWindow: () => windowModels(),
      writeWindow,
      withFileLock: withoutFileLock,
    });
    expect(result).toMatchObject({
      action: "updated",
      windowPercent: 40,
      contextWindow: 419_430,
      providers: ["deepseek", "opencode-go"],
    });
    expect(writeWindow).toHaveBeenCalledWith({
      model: "deepseek-v4-flash",
      windowPercent: 40,
      environment: {},
    });
  });

  it("wraps the global write in a provider management transaction", async () => {
    const writeWindow = vi.fn(() => ({
      model: "deepseek-v4-flash",
      windowPercent: 40,
      contextWindow: 419_430,
      providers: ["deepseek", "opencode-go"],
      overridden: [],
    }));
    await applyModelWindowChange({
      model: "deepseek-v4-flash",
      windowPercent: 40,
    }, {
      environment: {},
      loadWindow: () => windowModels(),
      writeWindow,
      withFileLock: withoutFileLock,
    });
    expect(writeWindow).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a provider has not been configured", () => {
    expect(() => previewModelWindowChange({
      model: "deepseek-v4-flash",
      windowPercent: 40,
    }, {
      environment: {},
      loadWindow: () => [],
    })).toThrow();
  });

  it("projects unset window values as JSON-safe resource fields", () => {
    const projected = projectModelWindow([
      {
        model: "deepseek-v4-flash",
        displayName: "DeepSeek V4 Flash",
        contextWindow: 419_430,
        maxContextWindow: 1_048_576,
        windowPercent: 40,
        providers: ["deepseek", "ocg-lunare"],
        perProvider: { deepseek: 40, "ocg-lunare": undefined },
        conflicts: false,
      },
      {
        model: "deepseek-v4-pro",
        displayName: "DeepSeek V4 Pro",
        contextWindow: 1_048_576,
        maxContextWindow: 1_048_576,
        providers: ["deepseek", "ocg-lunare"],
        perProvider: { deepseek: undefined, "ocg-lunare": undefined },
        conflicts: false,
      },
    ]);
    expect(projected[0]?.perProvider).toEqual({ deepseek: 40 });
    expect(projected[0]?.windowPercent).toBe(40);
    expect(projected[1]?.perProvider).toEqual({});
    expect(projected[1]).not.toHaveProperty("windowPercent");
    expect(() => fingerprintManagementValue(projected)).not.toThrow();
  });
});

function windowModels() {
  return [
    {
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      contextWindow: 419_430,
      maxContextWindow: 1_048_576,
      windowPercent: 40,
      providers: ["deepseek", "opencode-go"],
      perProvider: { deepseek: 40, "opencode-go": undefined },
      conflicts: false,
      windowConflict: false,
    },
    {
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      contextWindow: 1_048_576,
      maxContextWindow: 1_048_576,
      windowPercent: 100,
      providers: ["deepseek"],
    },
  ];
}

const withoutFileLock = async <T>(
  _path: string,
  operation: () => T | Promise<T>,
): Promise<T> => operation();
