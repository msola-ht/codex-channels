export interface OpencodeGoAccount {
  id: string;
  default: boolean;
}

export interface OpencodeGoAccountMarker {
  version: 1;
  provider: string;
  mode: "switching" | "exclusive";
}

export function isOpencodeGoProvider(provider: string): boolean;
export function opencodeGoAccountIdFromProvider(provider: string): string | undefined;
export function opencodeGoProviderId(accountId: string): string;
export function validateOpencodeGoAccountId(accountId: string): string;

export function opencodeGoAccountsDirectory(
  environment?: NodeJS.ProcessEnv,
): string;
export function opencodeGoAccountsFilePath(
  environment?: NodeJS.ProcessEnv,
): string;
export function opencodeGoAccountDirectory(
  environment: NodeJS.ProcessEnv,
  accountId: string,
): string;
export function opencodeGoAccountMarkerPath(
  environment: NodeJS.ProcessEnv,
  accountId: string,
): string;
export function opencodeGoAccountBackupDirectory(
  environment: NodeJS.ProcessEnv,
  accountId: string,
): string;

export function loadOpencodeGoAccounts(
  environment?: NodeJS.ProcessEnv,
): OpencodeGoAccount[];
export function writeOpencodeGoAccounts(
  environment: NodeJS.ProcessEnv,
  accounts: readonly OpencodeGoAccount[],
): OpencodeGoAccount[];
export function loadOpencodeGoDefaultAccount(
  environment?: NodeJS.ProcessEnv,
): OpencodeGoAccount | undefined;
export function readOpencodeGoAccountMarker(
  environment: NodeJS.ProcessEnv,
  accountId: string,
): OpencodeGoAccountMarker | undefined;
export function writeOpencodeGoAccountMarker(
  environment: NodeJS.ProcessEnv,
  accountId: string,
  mode: "switching" | "exclusive",
): void;

export function migrateLegacyOpencodeGoAccount(
  environment?: NodeJS.ProcessEnv,
): { changed: boolean; accountId: string };

export function opencodeGoApiKeyEnvironmentKey(accountId: string): string;
