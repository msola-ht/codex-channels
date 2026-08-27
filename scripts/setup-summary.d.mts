export interface SetupConfigurationSummary {
  primary: import("./model-provider-management.mjs").ModelProviderManagementState["primary"];
  codexDefaults: { model?: string; effort?: string };
  switchingProviders: Array<{
    id: string;
    displayName: string;
    kind: "managed" | "custom";
    mode: "switching";
  }>;
  modelDefaults: Array<{
    providerId: string;
    providerName: string;
    model: string;
    reasoningEffort?: string;
  }>;
  channels: Array<{
    id: "telegram" | "feishu" | "weixin";
    displayName: string;
    configured: true;
    enabled: boolean;
  }>;
  installedSkillCount: number;
  agent:
    | { status: "configured"; provider: string; model: string }
    | { status: "unavailable" | "not-configured" };
  apiProviderCount: number;
  configPath: string;
}

export interface SetupConfigurationSummaryOptions {
  environment?: NodeJS.ProcessEnv;
  loadGatewayDocument?: (environment: NodeJS.ProcessEnv) => {
    configPath: string;
    document: Record<string, unknown>;
  };
  loadProviderState?: (
    environment: NodeJS.ProcessEnv,
  ) => Promise<import("./model-provider-management.mjs").ModelProviderManagementState>;
  loadInstalledSkills?: (options: { environment: NodeJS.ProcessEnv }) => string[];
}

export function loadSetupConfigurationSummary(
  options?: SetupConfigurationSummaryOptions,
): Promise<SetupConfigurationSummary>;

export function writeSetupConfigurationSummary(
  options?: SetupConfigurationSummaryOptions & { output?: { write(value: string): unknown } },
): Promise<SetupConfigurationSummary>;
