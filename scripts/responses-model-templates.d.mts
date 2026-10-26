import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
export type ResponsesTemplateSource = "official" | "deepseek";
export function loadResponsesModelTemplates(source: ResponsesTemplateSource, environment?: NodeJS.ProcessEnv): Promise<ResponsesModelDefinition[]>;
export function responsesModelTemplatesFromCatalog(catalog: unknown, source?: ResponsesTemplateSource): ResponsesModelDefinition[];
