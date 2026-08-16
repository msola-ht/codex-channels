import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { loadManagedModelOptions } from "../src/codex-client/model-provider-catalog.js";

describe("DeepSeek model catalog", () => {
  it("keeps every selectable provider model in the reviewed API catalog baseline", () => {
    const baseline = JSON.parse(readFileSync(
      join(process.cwd(), "scripts/deepseek-catalog-baseline.json"),
      "utf8",
    )) as {
      models: Array<{
        slug: string;
        supportedInApi: boolean;
        visibility: string;
      }>;
    };

    for (const definition of deepseekProviderDefinition.models) {
      if (!definition.available) continue;
      expect(baseline.models).toContainEqual(expect.objectContaining({
        slug: definition.slug,
        supportedInApi: true,
        visibility: "list",
      }));
    }
  });

  it("makes the official Flash and Pro models selectable", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-deepseek-catalog-"));
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "sf-deepseek.models.json"), JSON.stringify({
      models: [
        model("deepseek-v4-flash", "DeepSeek-V4-Flash"),
        model("deepseek-v4-pro", "DeepSeek-V4-Pro"),
      ],
    }));

    const models = loadManagedModelOptions(
      codexHome,
      true,
      deepseekProviderDefinition,
    );

    expect(models).toMatchObject([
      { model: "deepseek-v4-flash", available: true },
      { model: "deepseek-v4-pro", available: true },
    ]);
  });

  it("ignores a leftover catalog when DeepSeek is not configured", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-deepseek-catalog-disabled-"));
    writeFileSync(join(codexHome, "sf-deepseek.models.json"), "not-json");

    expect(loadManagedModelOptions(
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
