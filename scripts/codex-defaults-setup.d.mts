import type { CodexDefaultSettingsClient } from "./codex-user-config.mjs";

export type CodexDefaultsClient = CodexDefaultSettingsClient;

export interface CodexDefaultsSetupResult {
  model: string;
  effort: string;
}

export interface CodexDefaultsSetupBackResult {
  action: "back";
}

export function runCodexDefaultsSetup(options?: {
  environment?: NodeJS.ProcessEnv;
  output?: { write(value: string): unknown };
  prompts?: {
    select(options: unknown): Promise<unknown>;
    confirm(options: unknown): Promise<unknown>;
    isCancel(value: unknown): boolean;
  };
  allowBack?: boolean;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexDefaultsClient>;
  primaryProvider?: (environment: NodeJS.ProcessEnv) => "openai" | "deepseek";
}): Promise<
  | CodexDefaultsSetupResult
  | CodexDefaultsSetupBackResult
  | undefined
>;
