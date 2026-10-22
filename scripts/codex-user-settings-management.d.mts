import type { CodexUserConfigClient } from "./codex-user-config.mjs";
import type { CodexUserConfigValue } from "./codex-user-config.mjs";
import type { CodexToolSettings } from "./codex-tool-settings.mjs";

export interface CodexPermissionValues {
  sandboxMode: "read-only" | "workspace-write";
  approvalPolicy: "on-request" | "never";
  networkAccess: boolean;
}
export type CodexPermissionChange = { kind: "permissions" } & Partial<CodexPermissionValues> & (
  Pick<CodexPermissionValues, "sandboxMode"> | Pick<CodexPermissionValues, "approvalPolicy"> | Pick<CodexPermissionValues, "networkAccess">
);

export type CodexUserSettingInput =
  | { kind: "tool-access"; path: string[]; value: CodexUserConfigValue }
  | {
      kind: "all";
      reasoningSummary: "auto" | "concise" | "detailed" | "none";
      planModeReasoningEffort: string;
      verbosity: "low" | "medium" | "high";
      checkForUpdateOnStartup: boolean;
      historyPersistence: "save-all" | "none";
      model: string;
      reasoningEffort: string;
      serviceTier: "default" | "fast" | "ultrafast";
      permissions: {
        sandboxMode: "read-only" | "workspace-write";
        approvalPolicy: "on-request" | "never";
        networkAccess: boolean;
      } | null;
    }
  | { kind: "defaults"; model: string; reasoningEffort: string }
  | { kind: "service-tier"; serviceTier: "default" | "fast" | "ultrafast" }
  | { kind: "approvals-reviewer"; value: "user" | "auto_review" }
  | { kind: "web-search"; mode: "live" | "indexed" | "cached" | "disabled" }
  | { kind: "update-plan"; enabled: boolean }
  | { kind: "auto-recap"; enabled: boolean }
  | {
      kind: "model-compact";
      contextWindow: number | null;
      autoCompactTokenLimit: number | null;
    }
  | {
      kind: "preferences";
      reasoningSummary?: "auto" | "concise" | "detailed" | "none" | null;
      planModeReasoningEffort?: string | null;
      verbosity?: "low" | "medium" | "high" | null;
      checkForUpdateOnStartup?: boolean | null;
      historyPersistence?: "save-all" | "none" | null;
    }
  | CodexPermissionChange;

export interface CodexUserSettingsState {
  toolSettings: CodexToolSettings;
  version: string;
  provider: string;
  defaultsEditable: boolean;
  modelsAvailable: boolean;
  accelerationAvailable: boolean;
  contextEditable: boolean;
  approvalsReviewer: {
    value: "user" | "auto_review" | null;
    editable: boolean;
    reason?: "unsupported-value" | "managed-policy" | "unavailable";
  };
  models: Array<{
    model: string;
    displayName: string;
    reasoningEfforts: Array<{ effort: string; description: string }>;
    defaultReasoningEffort: string;
    serviceTiers: Array<{ id: string; name: string }>;
    isDefault: boolean;
  }>;
  defaults: {
    configuredModel: string | null;
    model: string | null;
    reasoningEffort: string | null;
    serviceTier: string | null;
    fastEnabled: boolean;
    ultrafastEnabled: boolean;
    webSearch: "live" | "indexed" | "cached" | "disabled" | null;
    updatePlanEnabled: boolean | null;
    autoRecapEnabled: boolean | null;
    unsupportedFields: string[];
    reasoningSummary?: "auto" | "concise" | "detailed" | "none" | null;
    planModeReasoningEffort?: string | null;
    verbosity?: "low" | "medium" | "high" | null;
    checkForUpdateOnStartup?: boolean | null;
    historyPersistence?: "save-all" | "none" | null;
  };
  permissions: {
    editable: boolean;
    defaultPermissions: string | null;
    unsupportedFields: Array<keyof CodexPermissionValues>;
    sandboxMode: "read-only" | "workspace-write" | null;
    approvalPolicy: "on-request" | "never" | null;
    networkAccess: boolean | null;
  };
  compact: {
    contextWindow: number | null;
    autoCompactTokenLimit: number | null;
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

export type CodexUserSettingActivation =
  | "none"
  | "next-thread"
  | "next-tui"
  | "next-thread-and-tui";

export function loadCodexUserSettings(
  options?: CodexUserSettingsDependencies & { signal?: AbortSignal },
): Promise<CodexUserSettingsState>;

export function updateCodexUserSetting(
  input: CodexUserSettingInput,
  options: CodexUserSettingsDependencies & { expectedVersion: string; expectedTargetFingerprint?: string },
): Promise<{
  kind: CodexUserSettingInput["kind"];
  previousVersion: string;
  value: Record<string, unknown>;
  action: "updated" | "unchanged";
  willChange: boolean;
  activation: CodexUserSettingActivation;
  revision: string | null;
  consistency: "confirmed" | "unknown";
  writeStatus: "ok" | "okOverridden" | null;
  targetFingerprint?: string;
}>;

export function previewCodexUserSetting(
  input: CodexUserSettingInput,
  options: CodexUserSettingsDependencies & { expectedVersion: string },
): Promise<{
  kind: CodexUserSettingInput["kind"];
  previousVersion: string;
  value: Record<string, unknown>;
  action: "updated" | "unchanged";
  willChange: boolean;
  activation: CodexUserSettingActivation;
  revision: string | null;
  consistency: "confirmed" | "unknown";
  writeStatus: "ok" | "okOverridden" | null;
  targetFingerprint?: string;
}>;
