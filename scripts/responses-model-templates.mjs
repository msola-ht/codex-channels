import { readCustomBaseModelCatalog, completeCatalogPrompts } from "../runtime/model-template-catalog.mjs";
import { readDeepseekModelTemplateCatalog } from "../runtime/model-base-snapshot.mjs";
import { modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";
export { modelDefinitionsFromCatalog as responsesModelTemplatesFromCatalog } from "../runtime/model-catalog.mjs";

export async function loadResponsesModelTemplates(source, environment = process.env) {
  let catalog;
  if (source === "official") catalog = readCustomBaseModelCatalog(environment);
  else if (source === "deepseek") {
    catalog = completeCatalogPrompts(readDeepseekModelTemplateCatalog(environment), environment);
  } else throw new Error("模型模板来源无效");
  return responsesModelTemplatesFromCatalog(catalog, source);
}
