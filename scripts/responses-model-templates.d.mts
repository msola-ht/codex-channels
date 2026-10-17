import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
export type ResponsesTemplateSource = "official" | "deepseek";
export interface CustomModelDraftTemplate {
  source: ResponsesTemplateSource;
  model: string;
  displayName: string;
  draft: ResponsesModelDefinition;
  suggested: ResponsesModelDefinition;
}
export function loadCustomModelDraftTemplates(): Promise<CustomModelDraftTemplate[]>;
export function loadResponsesModelTemplates(source: ResponsesTemplateSource): Promise<ResponsesModelDefinition[]>;
export function responsesModelTemplatesFromCatalog(catalog: unknown, source?: ResponsesTemplateSource): ResponsesModelDefinition[];
