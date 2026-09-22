export interface DeepseekAccount { id: string; default: boolean }
export function validateDeepseekAccountId(id: unknown): string;
export function deepseekProviderId(id: string): `ds-${string}`;
export function isDeepseekAccountProvider(provider: unknown): boolean;
export function deepseekAccountIdFromProvider(provider: string): string | undefined;
export function deepseekAccountsFilePath(environment?: NodeJS.ProcessEnv): string;
export function deepseekAccountDirectory(environment: NodeJS.ProcessEnv, id: string): string;
export function deepseekAccountMarkerPath(environment: NodeJS.ProcessEnv, id: string): string;
export function deepseekApiKeyEnvironmentKey(id: string): string;
export function validateDeepseekAccounts(value: unknown): DeepseekAccount[];
export function loadDeepseekAccounts(environment?: NodeJS.ProcessEnv): DeepseekAccount[];
