import { readFileSync } from "node:fs";
import { normalizeDeepseekCatalogCapabilities } from "../runtime/model-catalog.mjs";
import { completeCatalogPrompts } from "../runtime/model-template-catalog.mjs";

const settings = JSON.parse(readFileSync(new URL("../provider-model-catalog.json", import.meta.url), "utf8"));

/** DS endpoint restrictions do not establish capabilities for CCG or OCG. */
export function createDeepseekTemplateCatalog(source, family) {
  if (!["deepseek", "ccg", "opencode-go"].includes(family)) throw new Error("DS 模板目标提供商无效");
  const catalog = completeCatalogPrompts(source);
  // Service offerings are not reusable model-template capabilities.
  for (const model of catalog.models) {
    delete model.service_tiers;
    delete model.additional_speed_tiers;
  }
  return family === "deepseek" ? normalizeDeepseekCatalogCapabilities(catalog) : catalog;
}

function appendFlashClone(source, slug, family) {
  const catalog = createDeepseekTemplateCatalog(source, family);
  const matches = catalog.models.filter((entry) => entry.slug === settings.flashSourceModel);
  if (matches.length !== 1) throw new Error("DS 模型目录必须包含唯一的 Flash 模板");
  if (catalog.models.some((entry) => entry.slug === slug)) {
    throw new Error("DS 模型目录与独立 V4.1 模型重复，请更新模型目录适配");
  }
  catalog.models.push({ ...structuredClone(matches[0]), slug, display_name: settings.v41DisplayName });
  return catalog;
}

export function createOpencodeGoCatalogWithTemplateBindings(source) {
  const catalog = appendFlashClone(source, settings.ocg.v41Model, "opencode-go");
  const templateBindings = Object.fromEntries(catalog.models.map(entry => [entry.slug, {
    source: "deepseek", model: entry.slug === settings.ocg.v41Model ? settings.flashSourceModel : entry.slug,
  }]));
  return { catalog, templateBindings };
}

export function createCcgCatalogWithTemplateBindings(source) {
  const catalog = appendFlashClone(source, settings.ccg.v41Model, "ccg");
  const templateBindings = {};
  catalog.models = catalog.models.map((entry) => {
    const clone = entry.slug === settings.ccg.v41Model;
    const slug = clone ? entry.slug : settings.ccg.modelIds[entry.slug];
    if (typeof slug !== "string") throw new Error(`CCG 缺少 DS 模型 ID 映射：${entry.slug}`);
    if (Object.hasOwn(templateBindings, slug)) throw new Error(`CCG DS 模型 ID 映射重复：${slug}`);
    templateBindings[slug] = { source: "deepseek", model: clone ? settings.flashSourceModel : entry.slug };
    return { ...entry, slug };
  });
  return { catalog, templateBindings };
}
