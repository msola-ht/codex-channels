import type {
  CodexUserConfigTransactionClient,
} from "./codex-user-config.mjs";
import type { CustomPrimaryProviderSetupClient } from "./custom-primary-provider-setup.mjs";

export interface PrimaryProviderCliPrompts {
  text(options: unknown): Promise<unknown>;
  select(options: unknown): Promise<unknown>;
  confirm(options: unknown): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface InteractivePrimaryProviderCliPrompts extends PrimaryProviderCliPrompts {
  password(options: unknown): Promise<unknown>;
}

export interface PrimaryProviderCliOptions {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: PrimaryProviderCliPrompts;
  confirmRemoval?: boolean;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigTransactionClient>;
}

export type InteractivePrimaryProviderCliOptions = Omit<
  PrimaryProviderCliOptions,
  "prompts" | "createClient"
> & {
  prompts?: InteractivePrimaryProviderCliPrompts;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CustomPrimaryProviderSetupClient>;
};

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
  options?: InteractivePrimaryProviderCliOptions,
): Promise<unknown>;
export function runCustomPrimaryProviderMenu(
  options?: InteractivePrimaryProviderCliOptions & { allowBack?: boolean },
): Promise<unknown>;
export function runPrimaryProviderCli(
  args: string[],
  options?: InteractivePrimaryProviderCliOptions,
): Promise<void>;
