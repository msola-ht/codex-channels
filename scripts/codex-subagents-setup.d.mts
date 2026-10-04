import type { ConfigActivationResult } from "./config-activation-result.mjs";
import type { CodexUserConfigTransactionClient } from "./codex-user-config.mjs";

export function runCodexSubagentsSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: {
    select(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  createClient?: (options: { environment: NodeJS.ProcessEnv }) => Promise<CodexUserConfigTransactionClient>;
}): Promise<{ action: "saved"; activationResult: ConfigActivationResult } | { action: "back" }>;
