export interface CcgAccount { id: string; default: boolean }
export function validateCcgAccountId(id: unknown): string;
export function ccgProviderId(id: string): `ccg-${string}`;
export function isCcgAccountProvider(provider: unknown): boolean;
export function ccgAccountIdFromProvider(provider: string): string | undefined;
export function ccgAccountsFilePath(environment?: NodeJS.ProcessEnv): string;
export function ccgAccountDirectory(environment: NodeJS.ProcessEnv, id: string): string;
export function ccgAccountMarkerPath(environment: NodeJS.ProcessEnv, id: string): string;
export function ccgApiKeyEnvironmentKey(id: string): string;
export function validateCcgAccounts(value: unknown): CcgAccount[];
export function loadCcgAccounts(environment?: NodeJS.ProcessEnv): CcgAccount[];
