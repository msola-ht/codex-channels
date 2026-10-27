export interface OllamaCloudAccount { id: string; default: boolean }
export function validateOllamaCloudAccountId(id: unknown): string;
export function ollamaCloudProviderId(id: string): `olc-${string}`;
export function isOllamaCloudAccountProvider(provider: unknown): boolean;
export function ollamaCloudAccountIdFromProvider(provider: string): string | undefined;
export function ollamaCloudAccountsFilePath(environment?: NodeJS.ProcessEnv): string;
export function ollamaCloudAccountDirectory(environment: NodeJS.ProcessEnv, id: string): string;
export function ollamaCloudAccountMarkerPath(environment: NodeJS.ProcessEnv, id: string): string;
export function ollamaCloudApiKeyEnvironmentKey(id: string): string;
export function validateOllamaCloudAccounts(value: unknown): OllamaCloudAccount[];
export function loadOllamaCloudAccounts(environment?: NodeJS.ProcessEnv): OllamaCloudAccount[];
