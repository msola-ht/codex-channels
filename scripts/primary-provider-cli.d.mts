import type { CodexUserConfigTransactionClient } from "./codex-user-config.mjs";

export interface PrimaryProviderCliOptions {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: {
    text(options: unknown): Promise<unknown>;
    select(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigTransactionClient>;
}

export function listPrimaryProviders(
  options?: PrimaryProviderCliOptions,
): Promise<void>;
export function switchPrimaryProvider(
  providerId: string,
  model?: string,
  options?: PrimaryProviderCliOptions,
): Promise<void>;
export function removePrimaryProvider(
  providerId: string,
  options?: PrimaryProviderCliOptions,
): Promise<void>;
export function addPrimaryProvider(
  options?: PrimaryProviderCliOptions,
): Promise<unknown>;
export function runCustomPrimaryProviderMenu(
  options?: PrimaryProviderCliOptions & { allowBack?: boolean },
): Promise<unknown>;
export function runPrimaryProviderCli(
  args: string[],
  options?: PrimaryProviderCliOptions,
): Promise<void>;
