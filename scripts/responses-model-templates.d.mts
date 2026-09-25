import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
import type { CustomPrimaryProviderSetupPrompts } from "./custom-primary-provider-setup.mjs";
export type ResponsesTemplateSource = "official" | "deepseek";
export function loadResponsesModelTemplates(source: ResponsesTemplateSource, environment?: NodeJS.ProcessEnv): Promise<ResponsesModelDefinition[]>;
export function responsesModelTemplatesFromCatalog(catalog: unknown, source?: ResponsesTemplateSource): ResponsesModelDefinition[];
export function promptResponsesModelImport(prompts: CustomPrimaryProviderSetupPrompts, previous?: ResponsesModelDefinition[], loadTemplates?: (source: ResponsesTemplateSource) => Promise<ResponsesModelDefinition[]>): Promise<ResponsesModelDefinition[] | undefined>;
