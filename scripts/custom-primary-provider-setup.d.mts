import type { CodexUserConfigTransactionClient } from "./codex-user-config.mjs";

export interface CustomPrimaryProviderSetupPrompts {
  text(options: unknown): Promise<unknown>;
  select(options: unknown): Promise<unknown>;
  confirm(options: unknown): Promise<unknown>;
  isCancel(value: unknown): boolean;
}

export interface CustomPrimaryProviderSetupOptions {
  allowBack?: boolean;
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: CustomPrimaryProviderSetupPrompts;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigTransactionClient>;
}

export function runCustomPrimaryProviderSetup(options?: CustomPrimaryProviderSetupOptions): Promise<
  | { provider: string; model: string }
  | { action: "back" | "cancel" }
  | undefined
>;
