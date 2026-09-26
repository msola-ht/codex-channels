export interface ClinePassAccount { id: string; default: boolean }
export function validateClinePassAccountId(id: unknown): string;
export function clinePassProviderId(id: string): `clp-${string}`;
export function isClinePassAccountProvider(provider: unknown): boolean;
export function clinePassAccountIdFromProvider(provider: string): string | undefined;
export function clinePassAccountsFilePath(environment?: NodeJS.ProcessEnv): string;
export function clinePassAccountDirectory(environment: NodeJS.ProcessEnv, id: string): string;
export function clinePassAccountMarkerPath(environment: NodeJS.ProcessEnv, id: string): string;
export function clinePassApiKeyEnvironmentKey(id: string): string;
export function validateClinePassAccounts(value: unknown): ClinePassAccount[];
export function loadClinePassAccounts(environment?: NodeJS.ProcessEnv): ClinePassAccount[];
