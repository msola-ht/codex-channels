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
