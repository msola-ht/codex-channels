import { readFileSync } from "node:fs";
import { customModelSamplingDefaults } from "../runtime/model-catalog.mjs";
import { readCustomBaseModelCatalog, completeCatalogPrompts } from "../runtime/model-template-catalog.mjs";
import { modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";
export { modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";

export async function loadResponsesModelTemplates(source) {
  let catalog;
  if (source === "official") catalog = readCustomBaseModelCatalog();
  else if (source === "deepseek") {
    catalog = completeCatalogPrompts(JSON.parse(readFileSync(new URL("../runtime/model-catalog-deepseek.json", import.meta.url), "utf8")));
  } else throw new Error("模型模板来源无效");
  return responsesModelTemplatesFromCatalog(catalog, source);
}

// A template is a starting point, not evidence about an arbitrary upstream.
// Copy prompts, their source and reusable context-management settings, plus
// the project's fixed sampling defaults. Model
// context and capabilities remain references until declared for the upstream.
export async function loadCustomModelDraftTemplates() {
  const templates = [];
  for (const source of ["official", "deepseek"]) {
    for (const suggested of await loadResponsesModelTemplates(source)) {
      const draft = {
        id: suggested.id,
        name: suggested.name,
        defaultReasoningEffort: null,
        sampling: { ...customModelSamplingDefaults },
        ...(suggested.instructions === undefined ? {} : { instructions: suggested.instructions }),
        ...(suggested.modelMessages === undefined ? {} : { modelMessages: structuredClone(suggested.modelMessages) }),
        ...(suggested.effectiveContextWindowPercent === undefined ? {} : { effectiveContextWindowPercent: suggested.effectiveContextWindowPercent }),
        ...(suggested.autoCompactTokenLimit === undefined ? {} : { autoCompactTokenLimit: suggested.autoCompactTokenLimit }),
        ...(suggested.truncationPolicy === undefined ? {} : { truncationPolicy: structuredClone(suggested.truncationPolicy) }),
        template: { source, model: suggested.id },
      };
      templates.push({ source, model: suggested.id, displayName: suggested.name, draft, suggested });
    }
  }
  return templates;
}
