import type { ModelProviderDefinition } from "./model-provider-definitions.mjs";
export function managedPrimaryCredentialEnvironmentKey(definition: ModelProviderDefinition, version?: string): string;
export function managedPrimaryCredentialPath(environment: NodeJS.ProcessEnv, definition: ModelProviderDefinition, environmentKey: string): string;
export function createManagedPrimaryCredential(definition: ModelProviderDefinition, apiKey: string): { environmentKey: string; content: string };
export function readManagedPrimaryCredential(environment: NodeJS.ProcessEnv, definition: ModelProviderDefinition, environmentKey: string): string;
