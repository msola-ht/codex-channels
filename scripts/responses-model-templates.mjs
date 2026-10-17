import { readFileSync } from "node:fs";
import { readCustomBaseModelCatalog } from "../runtime/model-template-catalog.mjs";
import { modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";
export { modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";

export async function loadResponsesModelTemplates(source) {
  let catalog;
  if (source === "official") catalog = readCustomBaseModelCatalog();
  else if (source === "deepseek") {
    catalog = JSON.parse(readFileSync(new URL("../runtime/model-catalog-deepseek.json", import.meta.url), "utf8"));
  } else throw new Error("模型模板来源无效");
  return responsesModelTemplatesFromCatalog(catalog, source);
}

// A template is a starting point, not evidence about an arbitrary upstream.
// Keep its prompts and context recommendations, but require explicit capability
// declarations before enabling protocol-dependent features.
export async function loadCustomModelDraftTemplates() {
  const templates = [];
  for (const source of ["official", "deepseek"]) {
    for (const suggested of await loadResponsesModelTemplates(source)) {
      const draft = structuredClone(suggested);
      for (const key of ["reasoningEfforts", "reasoningDescriptions", "supportsImages", "applyPatchToolType", "supportsSearchTool", "supportsImageDetailOriginal", "supportsVerbosity", "defaultVerbosity", "supportsReasoningSummary", "defaultReasoningSummary"]) delete draft[key];
      draft.defaultReasoningEffort = null;
      templates.push({ source, model: suggested.id, displayName: suggested.name, draft, suggested });
    }
  }
  return templates;
}
