import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
export type ResponsesTemplateSource = "official" | "deepseek";
/** An editable draft; a valid contextWindow is required before saving a definition. */
export type CustomModelDraftDefinition = Omit<ResponsesModelDefinition, "contextWindow"> & { contextWindow?: number };
export interface CustomModelDraftTemplate {
  source: ResponsesTemplateSource;
  model: string;
  displayName: string;
  draft: CustomModelDraftDefinition;
  suggested: ResponsesModelDefinition;
}
export function loadCustomModelDraftTemplates(): Promise<CustomModelDraftTemplate[]>;
export function loadResponsesModelTemplates(source: ResponsesTemplateSource): Promise<ResponsesModelDefinition[]>;
export function responsesModelTemplatesFromCatalog(catalog: unknown, source?: ResponsesTemplateSource): ResponsesModelDefinition[];
