import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { loadDeepseekModelOptions } from "../src/codex-client/deepseek-catalog.js";

describe("DeepSeek model catalog", () => {
  it("shows Pro as unavailable while keeping Flash selectable", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-deepseek-catalog-"));
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "deepseek.models.json"), JSON.stringify({
      models: [
        model("deepseek-v4-flash", "DeepSeek-V4-Flash"),
        model("deepseek-v4-pro", "DeepSeek-V4-Pro"),
      ],
    }));

    const models = loadDeepseekModelOptions(
      codexHome,
      true,
      deepseekProviderDefinition,
    );

    expect(models).toMatchObject([
      { model: "deepseek-v4-flash", available: true },
      {
        model: "deepseek-v4-pro",
        available: false,
        unavailableReason: "DeepSeek 官方暂未支持该模型接入 Codex",
      },
    ]);
  });

  it("ignores a leftover catalog when DeepSeek is not configured", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-deepseek-catalog-disabled-"));
    writeFileSync(join(codexHome, "deepseek.models.json"), "not-json");

    expect(loadDeepseekModelOptions(
      codexHome,
      false,
      deepseekProviderDefinition,
    )).toEqual([]);
  });
});

function model(slug: string, displayName: string) {
  return {
    slug,
    display_name: displayName,
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high", description: "High" }],
  };
}
