import type { CustomPrimaryProviderSetupPrompts } from "./custom-primary-provider-setup.mjs";
import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
export function promptResponsesModels(prompts: CustomPrimaryProviderSetupPrompts, defaultModel: string, previous?: ResponsesModelDefinition[]): Promise<ResponsesModelDefinition[] | undefined>;
