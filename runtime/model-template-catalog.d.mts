import type { ModelDefinition } from "./model-catalog.mjs";
export function readCustomBaseModelCatalog(environment?: NodeJS.ProcessEnv): { models: Record<string, unknown>[] };
export function withCustomBaseTemplate<T extends Partial<ModelDefinition>>(definition: T, environment?: NodeJS.ProcessEnv): T & { template: NonNullable<ModelDefinition["template"]>; modelMessages: Record<string, unknown>; experimentalSupportedTools: string[] };
export function completeCatalogPrompts<T extends {models: Record<string, unknown>[]}>(source: T, environment?: NodeJS.ProcessEnv): T;
export function completeDefinitionPrompts(definitions: ModelDefinition[], environment?: NodeJS.ProcessEnv): ModelDefinition[];
