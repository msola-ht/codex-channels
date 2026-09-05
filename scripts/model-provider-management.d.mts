export interface ModelProviderManagementState {
  configVersion: string | number | null | undefined;
  defaults: { model: string | null; reasoningEffort: string | null };
  primary: {
    id: string;
    displayName: string;
    kind: "official" | "managed" | "custom" | "unknown";
    mode: "official" | "exclusive" | "backup" | "unknown";
  };
  managedProviders: ManagedProviderManagementEntry[];
  customProviders: {
    fixedCandidates: CustomProviderCandidate[];
    switchingProviders: CustomSwitchingProviderEntry[];
    backupCandidates: CustomProviderCandidate[];
  };
  switchingProviders: Array<ManagedProviderManagementEntry | CustomSwitchingProviderEntry>;
  externalAgent:
    | { status: "configured"; provider: string; model: string }
    | { status: "unavailable" | "not-configured" };
}

export interface ManagedProviderManagementEntry {
  id: string;
  displayName: string;
  kind: "managed";
  mode: "switching" | "exclusive";
  model: string;
  reasoningEffort: string;
  models: Array<{
    id: string;
    displayName: string;
    contextWindow: number;
    reasoningEffort: string;
    reasoningEfforts: Array<{ effort: string; description: string }>;
    autoCompactLimit?: number;
    autoCompactPercent?: number;
  }>;
}

export interface CustomProviderCandidate {
  id: string;
  displayName: string;
  kind: "custom";
  state: "configured" | "backup";
  active: boolean;
  supportsWebsockets?: boolean;
  baseUrl: string;
}

export interface CustomSwitchingProviderEntry {
  id: string;
  displayName: string;
  kind: "custom";
  mode: "switching";
  model: string;
  reasoningEffort?: string;
  supportsWebsockets?: boolean;
  baseUrl: string;
  profileName: string;
}

export function loadModelProviderManagementState(options?: {
  environment?: NodeJS.ProcessEnv;
  readUserConfig?: (environment: NodeJS.ProcessEnv) => Promise<{
    config: Record<string, unknown>;
    version?: string | number | null;
  }>;
  loadManagedProviders?: (environment: NodeJS.ProcessEnv) => Array<{
    provider: string;
    displayName: string;
    mode: "switching" | "exclusive";
    model: string;
    reasoningEffort: string;
    models: Array<{
      model: string;
      displayName: string;
      contextWindow: number;
      reasoningEffort: string;
      reasoningEfforts: Array<{ effort: string; description: string }>;
      autoCompactLimit?: number;
      autoCompactPercent?: number;
    }>;
  }>;
  loadCustomSwitchingProviders?: (environment: NodeJS.ProcessEnv) => Array<{
    id: string;
    name: string;
    model: string;
    reasoningEffort?: string;
    supportsWebsockets?: boolean;
    baseUrl: string;
    profileName: string;
    apiKey?: string;
    profileContent?: string;
    childEnvironment?: Record<string, string>;
  }>;
  listCustomCandidates?: (providers: Record<string, unknown>) => string[];
  readBackup?: (environment: NodeJS.ProcessEnv) => Record<string, Record<string, unknown>>;
  loadAgentStatus?: (environment: NodeJS.ProcessEnv) => {
    externalRoleConfigured: boolean;
    legacyDsRoleConfigured?: boolean;
    provider?: string;
    model?: string;
  };
}): Promise<ModelProviderManagementState>;
