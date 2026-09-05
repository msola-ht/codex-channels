import type { ManagedModelProviderId } from "../runtime/model-provider-definitions.mjs";
import type { ManagedModelProviderRestorePreview } from "./managed-model-provider-setup.mjs";

export interface OpenCodeGoSetupPrompter {
  select(): Promise<string>;
  accountId?(): Promise<string>;
  contact?(): Promise<string>;
  selectAccount?(
    accounts: ReadonlyArray<{ id: string; default: boolean }>,
  ): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string, initialValue: boolean): Promise<boolean>;
}

export function previewOpencodeGoRestore(options?: {
  environment?: NodeJS.ProcessEnv;
}): ManagedModelProviderRestorePreview;

export function applyOpencodeGoRestore(
  input: { confirmRestore?: boolean },
  options?: { environment?: NodeJS.ProcessEnv },
): Promise<{ action: "restored" } & ManagedModelProviderRestorePreview>;

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
    text(options: unknown): Promise<unknown>;
    password(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  prompter?: OpenCodeGoSetupPrompter;
  configureRole?: (
    provider: ManagedModelProviderId,
    model: string | undefined,
    environment: NodeJS.ProcessEnv,
  ) => unknown | Promise<unknown>;
}): Promise<
  | { action: "back" }
  | { action: "restored" }
  | { action: "configured"; mode: "switching" | "exclusive"; accountId: string }
  | { action: "default-set" }
  | { action: "stopped" | "not-running" | "in-use"; accountId: string }
  | { action: "listed" }
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
    prompter?: OpenCodeGoSetupPrompter;
    configureRole?: (
      provider: ManagedModelProviderId,
      model: string | undefined,
      environment: NodeJS.ProcessEnv,
    ) => unknown | Promise<unknown>;
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
    configureRole?: (
      provider: ManagedModelProviderId,
      model: string | undefined,
      environment: NodeJS.ProcessEnv,
    ) => unknown | Promise<unknown>;
  },
): Promise<{ action: string; accountId: string }>;

export function refreshOpencodeGoCatalogForUpdate(
  environment?: NodeJS.ProcessEnv,
  options?: {
    downloadCatalog?: () => Promise<{
      catalog: { models: Array<Record<string, unknown>> };
      sha256: string;
    }>;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
): Promise<
  | { status: "not-configured" }
  | {
      status: "updated";
      catalogPath: string;
      manifestPath: string;
      modelCount: number;
      migratedProviders: string[];
      roleMigrated: boolean;
      defaultModelMigrationApplied: boolean;
    }
>;

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
    prompter?: OpenCodeGoSetupPrompter;
    configureRole?: (
      provider: ManagedModelProviderId,
      model: string | undefined,
      environment: NodeJS.ProcessEnv,
    ) => unknown | Promise<unknown>;
    downloadCatalog?: (fetchImpl: typeof fetch) => Promise<{
      catalog: { models: Array<Record<string, unknown>> };
      sha256: string;
    }>;
  },
): Promise<unknown>;
