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
        inputModalities: string[];
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
    expect(baseline.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4-flash-vision-exp",
      inputModalities: ["text", "image"],
    }));
  });

  it("makes the reviewed official models selectable with their input capabilities", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-deepseek-catalog-"));
    const providerDirectory = join(
      codexHome,
      ".codex-connect",
      "providers",
      "deepseek",
    );
    mkdirSync(providerDirectory, { recursive: true });
    writeFileSync(join(providerDirectory, "models.json"), JSON.stringify({
      models: [
        model("deepseek-v4-flash", "DeepSeek-V4-Flash", ["text"]),
        model(
          "deepseek-v4-flash-vision-exp",
          "DeepSeek-V4-Flash-Vision",
          ["text", "image"],
        ),
        model("deepseek-v4-pro", "DeepSeek-V4-Pro", ["text"]),
      ],
    }));

    const models = loadManagedModelOptions(
      providerDirectory,
      true,
      deepseekProviderDefinition,
    );

    expect(models).toMatchObject([
      { model: "deepseek-v4-flash", available: true, inputModalities: ["text"] },
      {
        model: "deepseek-v4-flash-vision-exp",
        available: true,
        inputModalities: ["text", "image"],
      },
      { model: "deepseek-v4-pro", available: true, inputModalities: ["text"] },
    ]);
  });

  it("ignores a leftover catalog when DeepSeek is not configured", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-deepseek-catalog-disabled-"));
    const providerDirectory = join(
      codexHome,
      ".codex-connect",
      "providers",
      "deepseek",
    );
    mkdirSync(providerDirectory, { recursive: true });
    writeFileSync(join(providerDirectory, "models.json"), "not-json");

    expect(loadManagedModelOptions(
      providerDirectory,
      false,
      deepseekProviderDefinition,
    )).toEqual([]);
  });

  it("fails closed when a selectable model has an unknown input capability", () => {
    const providerDirectory = mkdtempSync(join(tmpdir(), "codexc-deepseek-capability-"));
    writeFileSync(join(providerDirectory, "models.json"), JSON.stringify({
      models: [model("deepseek-v4-flash", "DeepSeek-V4-Flash", ["text", "video"])],
    }));

    expect(() => loadManagedModelOptions(
      providerDirectory,
      true,
      deepseekProviderDefinition,
    )).toThrow("DeepSeek 模型目录包含未知输入能力");
  });
});

function model(slug: string, displayName: string, inputModalities: string[]) {
  return {
    slug,
    display_name: displayName,
    default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high", description: "High" }],
    input_modalities: inputModalities,
  };
}
