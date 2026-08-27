import type {
  CodexUserConfigEdit,
  CodexUserConfigValue,
} from "./codex-user-config.mjs";

export type CodexUserConfigWriter = (
  environment: NodeJS.ProcessEnv,
  createEdits: (
    config: Record<string, CodexUserConfigValue | undefined>,
  ) => CodexUserConfigEdit[],
) => Promise<void>;

export interface AgentsStatus {
  configPath: string;
  roleConfigPath: string;
  multiAgentV2Enabled: boolean;
  externalRoleConfigured: boolean;
  legacyDsRoleConfigured: boolean;
  provider?: string;
  model?: string;
}

export interface ThirdPartyAgentProvider {
  provider: string;
  displayName: string;
  model: string;
  reasoningEffort: string;
  mode: "switching" | "exclusive";
  models: Array<{
    model: string;
    displayName: string;
    contextWindow: number;
    reasoningEffort: string;
    reasoningEfforts: Array<{ effort: string; description: string }>;
    autoCompactLimit?: number;
    autoCompactPercent?: number;
  }>;
}

export type ThirdPartyAgentChangeInput =
  | { action: "configure"; provider: string; model?: string }
  | { action: "disable" };

export type ThirdPartyAgentChangePreview =
  | {
      operation: "configure";
      current: { configured: boolean; provider: string | null; model: string | null };
      selection: {
        provider: string;
        providerDisplayName: string;
        model: string;
        modelDisplayName: string;
      };
      willChange: boolean;
      activation: "restart-all";
    }
  | {
      operation: "disable";
      current: { configured: boolean; provider: string | null; model: string | null };
      willChange: boolean;
      activation: "restart-all" | "none";
    };

export class AgentsManagementError extends Error {
  code: string;
  field: string;
}

export function agentsStatus(environment?: NodeJS.ProcessEnv): AgentsStatus;
export function loadThirdPartyAgentProviders(
  environment?: NodeJS.ProcessEnv,
): ThirdPartyAgentProvider[];
export function previewThirdPartyAgentChange(
  input: ThirdPartyAgentChangeInput,
  options?: {
    environment?: NodeJS.ProcessEnv;
    loadProviders?: typeof loadThirdPartyAgentProviders;
    loadStatus?: typeof agentsStatus;
    validateRoleAvailability?: boolean;
  },
): ThirdPartyAgentChangePreview;
export function applyThirdPartyAgentChange(
  input: ThirdPartyAgentChangeInput,
  options?: {
    environment?: NodeJS.ProcessEnv;
    loadProviders?: typeof loadThirdPartyAgentProviders;
    loadStatus?: typeof agentsStatus;
    configureRole?: typeof configureThirdPartyRole;
    disableRole?: typeof disableThirdPartyRole;
    validateRoleAvailability?: boolean;
  },
): Promise<
  | {
      action: "configured";
      activation: "restart-all";
      previous: ThirdPartyAgentChangePreview["current"];
      selection: { provider: string; model: string };
    }
  | {
      action: "disabled" | "unchanged";
      activation: "restart-all" | "none";
      previous: ThirdPartyAgentChangePreview["current"];
    }
>;
export function assertThirdPartyRoleAvailable(environment?: NodeJS.ProcessEnv): void;
export function configureThirdPartyRole(
  provider: string,
  model?: string,
  environment?: NodeJS.ProcessEnv,
  dependencies?: { updateConfig?: CodexUserConfigWriter },
): Promise<{ role: "external"; provider: string; model: string }>;
export function disableThirdPartyRole(
  environment?: NodeJS.ProcessEnv,
  dependencies?: { updateConfig?: CodexUserConfigWriter },
): Promise<boolean>;
export function assertThirdPartyRoleDoesNotUseProvider(
  provider: string,
  environment?: NodeJS.ProcessEnv,
): void;
export function removeManagedThirdPartyRole(
  environment?: NodeJS.ProcessEnv,
  dependencies?: {
    updateConfig?: CodexUserConfigWriter;
    provider?: string;
    disableFeature?: boolean;
  },
): Promise<boolean>;
