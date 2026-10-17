import type { ModelDefinition } from "./model-catalog.mjs";
export function completeCatalogPrompts<T extends {models: Record<string, unknown>[]}>(source: T): T;
export function completeDefinitionPrompts(definitions: ModelDefinition[]): ModelDefinition[];
