import { describe, expect, it } from "vitest";
import { createCcgCatalog, createOpencodeGoCatalog } from "../scripts/provider-model-catalog.mjs";

function fixture() {
  return {
    models: ["deepseek-flash", "deepseek-v4-pro"].map((slug) => ({
      slug, display_name: slug, context_window: 1_048_576,
      input_modalities: ["text", "image"], default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      model_messages: { instructions_template: "Flash instructions", instructions_variables: { value: "original" } },
      experimental_supported_tools: ["tool-a"],
    })),
  };
}

describe("Provider catalogs derived from DS", () => {
  it.each([
    [createOpencodeGoCatalog, "deepseek-v4.1-flash", "deepseek-flash", "deepseek-v4-pro"],
    [createCcgCatalog, "deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  ] as const)("copies complete Flash metadata without mutating the source (%s)", (adapt, slug, flash, pro) => {
    const source = fixture();
    const before = structuredClone(source);
    const catalog = adapt(source);
    expect(catalog.models.map((entry) => entry.slug)).toEqual([flash, pro, slug]);
    expect(catalog.models[0]).toEqual({ ...before.models[0], slug: flash });
    expect(catalog.models[1]).toEqual({ ...before.models[1], slug: pro });
    expect(catalog.models[2]).toEqual({ ...before.models[0], slug, display_name: "DeepSeek V4.1 Flash" });
    (catalog.models[2]!.input_modalities as string[]).push("audio");
    expect(catalog.models[0]!.input_modalities).toEqual(["text", "image"]);
    expect(source).toEqual(before);
  });

  it("rejects missing Flash and unreviewed CCG model IDs", () => {
    const source = fixture();
    source.models.shift();
    expect(() => createOpencodeGoCatalog(source)).toThrow("Flash 模板");
    const changed = fixture();
    changed.models[1]!.slug = "unknown-model";
    expect(() => createCcgCatalog(changed)).toThrow("模型 ID 映射");
  });
});
