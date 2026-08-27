import type { CodexUserConfigClient } from "./codex-user-config.mjs";

export type CodexUserSettingInput =
  | {
      kind: "all";
      model: string;
      reasoningEffort: string;
      fastEnabled: boolean;
      sandboxMode: "read-only" | "workspace-write";
      approvalPolicy: "untrusted" | "on-request" | "never";
      networkAccess: boolean;
    }
  | { kind: "defaults"; model: string; reasoningEffort: string }
  | { kind: "fast"; enabled: boolean }
  | { kind: "web-search"; mode: "live" | "indexed" | "cached" | "disabled" }
  | {
      kind: "preferences";
      reasoningSummary: "auto" | "concise" | "detailed" | "none";
      planModeReasoningEffort: string;
      verbosity: "low" | "medium" | "high";
      personality: "none" | "friendly" | "pragmatic";
      checkForUpdateOnStartup: boolean;
      historyPersistence: "save-all" | "none";
    }
  | {
      kind: "permissions";
      sandboxMode: "read-only" | "workspace-write";
      approvalPolicy: "untrusted" | "on-request" | "never";
      networkAccess: boolean;
    };

export interface CodexUserSettingsState {
  version: string;
  provider: string;
  defaultsEditable: boolean;
  models: Array<{
    model: string;
    displayName: string;
    reasoningEfforts: Array<{ effort: string; description: string }>;
    defaultReasoningEffort: string;
    isDefault: boolean;
  }>;
  defaults: {
    model: string | null;
    reasoningEffort: string | null;
    fastEnabled: boolean;
    webSearch: "live" | "indexed" | "cached" | "disabled" | null;
    reasoningSummary?: "auto" | "concise" | "detailed" | "none" | null;
    planModeReasoningEffort?: string | null;
    verbosity?: "low" | "medium" | "high" | null;
    personality?: "none" | "friendly" | "pragmatic" | null;
    checkForUpdateOnStartup?: boolean | null;
    historyPersistence?: "save-all" | "none" | null;
  };
  permissions: {
    editable: boolean;
    defaultPermissions: string | null;
    sandboxMode: "read-only" | "workspace-write" | null;
    approvalPolicy: "untrusted" | "on-request" | "never" | null;
    networkAccess: boolean | null;
  };
}

export class CodexUserSettingsError extends Error {
  code: string;
  field: string;
}

export interface CodexUserSettingsDependencies {
  environment?: NodeJS.ProcessEnv;
  createClient?: (options: {
    environment: NodeJS.ProcessEnv;
  }) => Promise<CodexUserConfigClient>;
  primaryProvider?: (environment: NodeJS.ProcessEnv) => string;
}

export function loadCodexUserSettings(
  options?: CodexUserSettingsDependencies,
): Promise<CodexUserSettingsState>;

export function updateCodexUserSetting(
  input: CodexUserSettingInput,
  options: CodexUserSettingsDependencies & { expectedVersion: string },
): Promise<{
  kind: CodexUserSettingInput["kind"];
  previousVersion: string;
  value: Record<string, unknown>;
  activation: "restart-all";
}>;
