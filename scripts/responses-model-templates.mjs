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
// Copy only prompts and their source. Context and capabilities are references
// in suggested, and must be declared separately for the actual upstream.
export async function loadCustomModelDraftTemplates() {
  const templates = [];
  for (const source of ["official", "deepseek"]) {
    for (const suggested of await loadResponsesModelTemplates(source)) {
      const draft = {
        id: suggested.id,
        name: suggested.name,
        defaultReasoningEffort: null,
        ...(suggested.instructions === undefined ? {} : { instructions: suggested.instructions }),
        ...(suggested.modelMessages === undefined ? {} : { modelMessages: structuredClone(suggested.modelMessages) }),
        template: { source, model: suggested.id },
      };
      templates.push({ source, model: suggested.id, displayName: suggested.name, draft, suggested });
    }
  }
  return templates;
}
