export function runOpenCodeGoSetup(options?: {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  fetchImpl?: typeof fetch;
  downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{
    catalog: { models: Array<Record<string, unknown>> };
    sha256: string;
  }>;
  prompts?: {
    select(options: unknown): Promise<unknown>;
    multiselect?(options: unknown): Promise<unknown>;
    text(options: unknown): Promise<unknown>;
    password(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
}): Promise<
  | { action: "back" }
  | { action: "cancelled" }
  | { action: "configured"; mode: "switching" | "exclusive"; accountId: string }
  | { action: "default-set" | "unchanged" }
  | { action: "catalog-updated"; activation: "restart-all"; models: string[] }
  | undefined
>;

export function addOpencodeGoAccount(
  accountId: string,
  options?: {
    mode?: "switching" | "exclusive";
    reconfigure?: boolean;
    email?: string;
    phone?: string;
    contact?: string;
    environment?: NodeJS.ProcessEnv;
    output?: { write(value: string): unknown };
    fetchImpl?: typeof fetch;
    downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{
      catalog: { models: Array<Record<string, unknown>> };
      sha256: string;
    }>;
    prompts?: unknown;
  },
): Promise<{ action: string; mode?: string; accountId?: string }>;

export function printOpencodeGoAccounts(
  environment?: NodeJS.ProcessEnv,
  output?: { write(value: string): unknown },
): void;

export function removeOpencodeGoAccount(
  accountId: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    output?: { write(value: string): unknown };
    prompts?: unknown;
    confirm?: boolean;
  },
): Promise<{ action: string; accountId?: string }>;

export function setOpencodeGoDefaultAccount(
  accountId: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
  },
): Promise<{ action: string; accountId: string; activation: "none" | "restart-all" }>;

export function stopOpencodeGoAccount(
  accountId: string,
  options?: {
    environment?: NodeJS.ProcessEnv;
    output?: { write(value: string): unknown };
    silent?: boolean;
  },
): Promise<{ action: string; accountId: string }>;

export function runOpencodeGoAccountCli(
  args: string[],
  options?: {
    environment?: NodeJS.ProcessEnv;
    output?: { write(value: string): unknown };
    prompts?: unknown;
    downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{
      catalog: { models: Array<Record<string, unknown>> };
      sha256: string;
    }>;
  },
): Promise<unknown>;
