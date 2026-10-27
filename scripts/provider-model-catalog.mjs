import { readFileSync } from "node:fs";
import { normalizeDeepseekCatalogCapabilities, modelDefinitionsFromCatalog } from "../runtime/model-catalog.mjs";
import { completeCatalogPrompts } from "../runtime/model-template-catalog.mjs";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { withThirdPartyLocalTools } from "../runtime/third-party-model-catalog.mjs";

const settings = JSON.parse(readFileSync(new URL("../provider-model-catalog.json", import.meta.url), "utf8"));

/** DS endpoint restrictions do not establish capabilities for CCG or OCG. */
export function createDeepseekTemplateCatalog(source, family, environment = process.env) {
  if (!["deepseek", "ccg", "opencode-go"].includes(family)) throw new Error("DS 模板目标提供商无效");
  const catalog = completeCatalogPrompts(source, environment);
  // Service offerings are not reusable model-template capabilities.
  for (const model of catalog.models) {
    delete model.service_tiers;
    delete model.additional_speed_tiers;
  }
  return family === "deepseek" ? normalizeDeepseekCatalogCapabilities(catalog) : catalog;
}

function appendFlashClone(source, slug, family, environment) {
  const catalog = createDeepseekTemplateCatalog(source, family, environment);
  const matches = catalog.models.filter((entry) => entry.slug === settings.flashSourceModel);
  if (matches.length !== 1) throw new Error("DS 模型目录必须包含唯一的 Flash 模板");
  if (catalog.models.some((entry) => entry.slug === slug)) {
    throw new Error("DS 模型目录与独立 V4.1 模型重复，请更新模型目录适配");
  }
  catalog.models.push({ ...structuredClone(matches[0]), slug, display_name: settings.v41DisplayName });
  return catalog;
}

export function createOpencodeGoCatalogWithTemplateBindings(source, environment = process.env) {
  const catalog = appendFlashClone(source, settings.ocg.v41Model, "opencode-go", environment);
  const templateBindings = Object.fromEntries(catalog.models.map(entry => [entry.slug, {
    source: "deepseek", model: entry.slug === settings.ocg.v41Model ? settings.flashSourceModel : entry.slug,
  }]));
  return { catalog, templateBindings };
}

export function createCcgCatalogWithTemplateBindings(source, environment = process.env) {
  const catalog = appendFlashClone(source, settings.ccg.v41Model, "ccg", environment);
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

/** Fixed upstream IDs; DS supplies reusable metadata, never CLP Responses capabilities. */
export function createClinePassCatalogWithTemplateBindings(source, environment = process.env) {
  const templates = modelDefinitionsFromCatalog(completeCatalogPrompts(source, environment), "deepseek");
  const templateBindings = {};
  const definitions = Object.entries(settings.clp.modelIds).map(([id, sourceId]) => {
    const matches = templates.filter(model => model.id === sourceId);
    if (matches.length !== 1) throw new Error(`CLP 缺少唯一的 DS 模板：${sourceId}`);
    const model = structuredClone(matches[0]);
    delete model.template;
    templateBindings[id] = { source: "deepseek", model: sourceId };
    return { ...model, id, name: id.slice("cline-pass/".length),
      reasoningEfforts: [...new Set(["none", ...(model.reasoningEfforts ?? [])])],
      supportsImageDetailOriginal: false, supportsReasoningSummary: false, defaultReasoningSummary: "none",
      supportsVerbosity: true, defaultVerbosity: "medium", applyPatchToolType: "freeform", supportsSearchTool: true };
  });
  const catalog = withThirdPartyLocalTools(createResponsesModelCatalog(definitions, definitions[0].id, undefined, environment), environment);
  for (const model of catalog.models) model.cline_request_profile = templateBindings[model.slug].model === settings.flashSourceModel ? "deepseek-flash" : "standard";
  return { catalog: { models: catalog.models }, templateBindings };
}

/** Exact cloud IDs and capabilities are maintained separately from the reusable DS template.
 * This is configuration, not evidence of paid upstream inference verification. */
export function createOllamaCloudCatalogWithTemplateBindings(source, environment = process.env) {
  const templates = modelDefinitionsFromCatalog(completeCatalogPrompts(source, environment), "deepseek");
  const templateBindings = {};
  const definitions = settings.olc.models.map(({ template, ...entry }) => {
    const matches = templates.filter(model => model.id === template);
    if (matches.length !== 1) throw new Error(`OLC 缺少唯一的 DS 模板：${template}`);
    const model = structuredClone(matches[0]);
    delete model.template;
    templateBindings[entry.id] = { source: "deepseek", model: template };
    const contextWindow = Math.min(model.contextWindow, 393_216);
    return { ...model, ...entry, contextWindow, maxContextWindow: contextWindow,
      reasoningEfforts: ["low", "high", "max"],
      supportsImageDetailOriginal: false, supportsReasoningSummary: false, defaultReasoningSummary: "none",
      supportsVerbosity: false, defaultVerbosity: null, applyPatchToolType: "freeform", supportsSearchTool: true };
  });
  const catalog = withThirdPartyLocalTools(createResponsesModelCatalog(definitions, definitions[0].id, undefined, environment), environment);
  return { catalog: { models: catalog.models }, templateBindings };
}
