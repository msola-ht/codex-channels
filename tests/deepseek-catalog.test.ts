import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { deepseekProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { loadManagedModelOptions } from "../src/codex-client/model-provider-catalog.js";

describe("DeepSeek model catalog", () => {
  it("records the reviewed official catalog baseline with model capabilities", () => {
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

    expect(baseline.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-flash",
      inputModalities: ["text", "image"],
    }));
    expect(baseline.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4-pro",
      supportedInApi: true,
      visibility: "list",
    }));
  });

  it("makes every model in the downloaded catalog selectable with its input capabilities", () => {
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
        model("deepseek-flash", "DeepSeek-Flash", ["text", "image"]),
        model("deepseek-v4-pro", "DeepSeek-V4-Pro", ["text"]),
        model("deepseek-v4-flash", "DeepSeek-V4-Flash", ["text"]),
      ],
    }));

    const models = loadManagedModelOptions(
      providerDirectory,
      true,
      deepseekProviderDefinition,
    );

    expect(models).toMatchObject([
      {
        model: "deepseek-flash",
        available: true,
        inputModalities: ["text", "image"],
      },
      { model: "deepseek-v4-pro", available: true, inputModalities: ["text"] },
      { model: "deepseek-v4-flash", available: true, inputModalities: ["text"] },
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

  it("fails closed when a catalog model name is invalid", () => {
    const providerDirectory = mkdtempSync(join(tmpdir(), "codexc-deepseek-slug-"));
    writeFileSync(join(providerDirectory, "models.json"), JSON.stringify({
      models: [model("DeepSeek Flash", "DeepSeek Flash", ["text"])],
    }));

    expect(() => loadManagedModelOptions(
      providerDirectory,
      true,
      deepseekProviderDefinition,
    )).toThrow("DeepSeek 模型目录包含无效模型名");
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
