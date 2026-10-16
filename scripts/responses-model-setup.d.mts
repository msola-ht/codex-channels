import type { CustomPrimaryProviderSetupPrompts } from "./custom-primary-provider-setup.mjs";
import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs";
export function promptContextWindow(prompts: CustomPrimaryProviderSetupPrompts, id: string, current: number | undefined, maximumContext: number, options?: { includeMaximum?: boolean }): Promise<number | undefined>;
export function promptResponsesModels(prompts: CustomPrimaryProviderSetupPrompts, defaultModel: string, previous?: ResponsesModelDefinition[], importedIds?: string[], output?: { write(value: string): unknown }, upstreamWireApi?: "responses" | "chat_completions", retainedModels?: string[]): Promise<ResponsesModelDefinition[] | undefined>;
