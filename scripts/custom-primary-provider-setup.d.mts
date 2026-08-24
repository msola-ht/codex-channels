import type {
  CodexUserConfigModelOption,
  CodexUserConfigTransactionClient,
} from "./codex-user-config.mjs";

export interface CustomPrimaryProviderSetupClient extends CodexUserConfigTransactionClient {
  listModels(): Promise<CodexUserConfigModelOption[]>;
}

export interface CustomPrimaryProviderSetupPrompts {
  text(options: unknown): Promise<unknown>;
  password(options: unknown): Promise<unknown>;
  select(options: unknown): Promise<unknown>;
  confirm(options: unknown): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface CustomPrimaryProviderSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: CustomPrimaryProviderSetupPrompts;
  providerId?: string;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CustomPrimaryProviderSetupClient>;
}

export function runCustomPrimaryProviderSetup(options?: CustomPrimaryProviderSetupOptions): Promise<
  | { provider: string; model: string }
  | { action: "back" | "cancel" }
  | undefined
>;
