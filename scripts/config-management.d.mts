export type GatewaySettingActivation =
  | "none"
  | "restart-gateway"
  | "restart-all"
  | "reinstall-services";

export class ConfigManagementError extends Error {
  readonly code: string;
  readonly field: string;
}

export interface GatewaySettings {
  configPath: string;
  display: {
    operationUpdates: "full" | "compact" | "hidden";
    planUpdatesEnabled: boolean;
    reasoningEnabled: boolean;
    priceCurrency: "cny" | "usd";
  };
  system: {
    approvalTimeoutSeconds: number;
    sandbox: "read-only" | "workspace-write";
    defaultWorkspace: string | null;
    defaultModel: string | null;
    workspaces: Array<{ id: string; name: string }>;
  };
  automation: {
    scheduledTasksEnabled: boolean;
    threadSectionAdministrators: string[];
    threadSectionAdministratorCandidates: Array<{
      value: string;
      surface: "telegram" | "feishu" | "weixin";
      actorId: string;
      displayName: string;
    }>;
  };
  network: Record<"http_proxy" | "https_proxy" | "all_proxy" | "no_proxy", {
    configured: boolean;
  }>;
  advanced: {
    loggingLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    pluginApiEnabled: boolean;
  };
  telegram: { configured: boolean; messageFormat: "html" | "rich" };
  channels: Array<{
    id: "telegram" | "feishu" | "weixin";
    displayName: string;
    configured: true;
    enabled: boolean;
  }>;
}

export type GatewaySettingInput =
  | { kind: "display.operation-updates"; value: "full" | "compact" | "hidden" }
  | { kind: "display.plan-updates"; value: boolean }
  | { kind: "display.reasoning"; value: boolean }
  | { kind: "display.price-currency"; value: "cny" | "usd" }
  | { kind: "telegram.message-format"; value: "html" | "rich" }
  | { kind: "system.approval-timeout"; value: number }
  | { kind: "system.sandbox"; value: "read-only" | "workspace-write" }
  | { kind: "system.default-workspace"; value: string }
  | { kind: "system.default-model"; value: string | null }
  | { kind: "automation.scheduled-tasks"; value: boolean }
  | { kind: "automation.thread-section-administrators"; value: string[] }
  | { kind: "advanced.logging-level"; value: GatewaySettings["advanced"]["loggingLevel"] }
  | { kind: "advanced.plugin-api"; value: boolean }
  | {
      kind: "network.proxy";
      field: "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy";
      action: "set" | "clear";
      value?: string;
    };

export function loadGatewaySettings(environment?: NodeJS.ProcessEnv): GatewaySettings;

export function validateNetworkProxyValue(
  field: "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy" | string,
  value: unknown,
): string | undefined;

export function updateGatewaySetting(
  input: GatewaySettingInput,
  options?: {
    environment?: NodeJS.ProcessEnv;
    writeConfig?: (configPath: string, document: unknown) => void;
  },
): {
  kind: GatewaySettingInput["kind"];
  configPath: string;
  value: unknown;
  activation: GatewaySettingActivation;
};
