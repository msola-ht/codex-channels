import type { ModelDefinition } from "./model-catalog.mjs";
export function readCustomBaseModelCatalog(): { models: Record<string, unknown>[] };
export function withCustomBaseTemplate<T extends Partial<ModelDefinition>>(definition: T): T & { template: NonNullable<ModelDefinition["template"]>; modelMessages: Record<string, unknown>; experimentalSupportedTools: string[] };
export function completeCatalogPrompts<T extends {models: Record<string, unknown>[]}>(source: T): T;
export function completeDefinitionPrompts(definitions: ModelDefinition[]): ModelDefinition[];
