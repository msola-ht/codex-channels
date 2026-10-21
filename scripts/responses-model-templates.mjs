import { readFileSync } from "node:fs";
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
