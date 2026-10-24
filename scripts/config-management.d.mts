export type GatewaySettingActivation =
  | "none"
  | "next-read"
  | "reload"
  | "restart-gateway"
  | "restart-webui"
  | "restart-app-server"
  | "restart-app-server-gateway-webui"
  | "restart-all"
  | "reinstall-services";

import type { ConfigActivationResult } from "./config-activation-result.mjs";

export class ConfigManagementError extends Error {
  readonly code: string;
  readonly field: string;
}

export interface GatewaySettings {
  configPath: string;
  revision: string;
  display: {
    operationUpdates: "full" | "compact" | "hidden";
    planUpdatesEnabled: boolean;
    reasoningEnabled: boolean;
    modelAliases: Record<string, string>;
  };
  system: {
    approvalTimeoutSeconds: number;
    idleReleaseMinutes: number;
    defaultWorkspace: string | null;
    defaultModel: string | null;
    modelTrafficMode: "production" | "debug";
    modelTrafficDumpEnabled: boolean;
    modelTrafficRetentionDays: number;
    officialTuiIdentity: {
      followCliVersion: boolean;
      clientIdentity: {
        name: string | null;
        title: string | null;
        version: string | null;
      };
      upstreamUserAgent: string | null;
      terminalIdentity: string | null;
      defaults: {
        name: string;
        version: string;
      };
    };
    appServerTimezone: string | null;
    gatewayTimezone: string | null;
    workspaces: Array<{ id: string; name: string }>;
  };
  automation: {
    scheduledTasksEnabled: boolean;
  };
  network: Record<"http_proxy" | "https_proxy" | "all_proxy" | "no_proxy", {
    configured: boolean;
  }>;
  advanced: {
    loggingLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  };
  telegram: { configured: boolean; messageFormat: "html" | "rich" };
  webui: {
    enabled?: boolean;
    host: "127.0.0.1" | "::1" | "0.0.0.0";
    port: number;
    tokenConfigured: boolean;
  };
  metrics: {
    storage: { retentionDays: number; maxRows: number };
  };
  channels: Array<{
    id: "telegram" | "feishu" | "weixin" | "qq";
    displayName: string;
    configured: true;
    enabled: boolean;
  }>;
}

export type GatewaySettingInput =
  | { kind: "display.operation-updates"; value: "full" | "compact" | "hidden" }
  | { kind: "display.plan-updates"; value: boolean }
  | { kind: "display.reasoning"; value: boolean }
  | { kind: "display.model-aliases"; value: Record<string, string> }
  | { kind: "telegram.message-format"; value: "html" | "rich" }
  | { kind: "system.approval-timeout"; value: number }
  | { kind: "system.idle-release-minutes"; value: number }
  | { kind: "system.default-workspace"; value: string }
  | { kind: "system.default-model"; value: string | null }
  | { kind: "system.model-traffic-dump"; value: boolean }
  | { kind: "system.model-traffic-mode"; value: "production" | "debug" }
  | { kind: "system.model-traffic-retention-days"; value: number }
  | {
      kind: "system.official-tui-identity";
      value: {
        clientIdentity: {
          name?: string | null;
          title?: string | null;
          version?: string | null;
        } | null;
        followCliVersion: boolean;
        upstreamUserAgent: string | null;
        terminalIdentity: string | null;
      };
    }
  | { kind: "system.app-server-timezone"; value: string | null }
  | { kind: "system.gateway-timezone"; value: string | null }
  | { kind: "automation.scheduled-tasks"; value: boolean }
  | { kind: "advanced.logging-level"; value: GatewaySettings["advanced"]["loggingLevel"] }
  | {
      kind: "network.proxy";
      field: "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy";
      action: "set" | "clear";
      value?: string;
    }
  | {
      kind: "network.proxy-batch";
      values: {
        http_proxy?: string | null;
        https_proxy?: string | null;
        all_proxy?: string | null;
      };
    }
  | { kind: "webui.enabled"; value: boolean }
  | { kind: "webui.host"; value: "127.0.0.1" | "::1" | "0.0.0.0" | null; token?: string }
  | { kind: "webui.port"; value: number | null }
  | { kind: "webui.token"; action: "set" | "clear" | "generate"; value?: string }
  | { kind: "metrics.storage"; retentionDays: number; maxRows: number };

export function loadGatewaySettings(environment?: NodeJS.ProcessEnv): GatewaySettings;

export function applyTerminalIdentityFromEnvironment(
  environment?: NodeJS.ProcessEnv,
): string | null;

export function validateNetworkProxyValue(
  field: "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy" | string,
  value: unknown,
): string | undefined;

export function updateGatewaySetting(
  input: Exclude<GatewaySettingInput, { kind: "system.default-model" }>,
  options: {
    environment?: NodeJS.ProcessEnv;
    expectedRevision: string;
    readConfig?: (configPath: string, encoding: "utf8") => string;
    writeConfig?: (configPath: string, document: unknown) => void;
    writeProxyConfig?: (configPath: string, content: string, snapshot: import("../runtime/codex-proxy-env.mjs").CodexProxySnapshot) => void;
    skipBackup?: boolean;
  },
): {
  kind: GatewaySettingInput["kind"];
  configPath: string;
  previousRevision: string;
  backupPath?: string;
  value: unknown;
  activation: GatewaySettingActivation;
  activationResult: ConfigActivationResult;
  generatedWebuiToken?: string;
};

export function updateGatewayDefaultModelSetting(
  input: Extract<GatewaySettingInput, { kind: "system.default-model" }>,
  options: Parameters<typeof updateGatewaySetting>[1] & {
    createClient?: (options: { environment: NodeJS.ProcessEnv }) => Promise<
      import("./codex-user-config.mjs").CodexUserConfigClient
    >;
  },
): Promise<ReturnType<typeof updateGatewaySetting>>;
