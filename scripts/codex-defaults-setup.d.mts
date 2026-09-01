import type { CodexDefaultSettingsClient } from "./codex-user-config.mjs";
import type { ConfigActivationResult } from "./config-activation-result.mjs";

export type CodexDefaultsClient = CodexDefaultSettingsClient;

export interface CodexDefaultsSetupResult {
  model: string;
  effort: string;
  activation: "restart-all";
  activationResult: ConfigActivationResult;
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
  primaryProvider?: (environment: NodeJS.ProcessEnv) => string;
  loadSettings?: typeof import("./codex-user-settings-management.mjs").loadCodexUserSettings;
  updateSetting?: typeof import("./codex-user-settings-management.mjs").updateCodexUserSetting;
}): Promise<
  | CodexDefaultsSetupResult
  | CodexDefaultsSetupBackResult
  | undefined
>;
