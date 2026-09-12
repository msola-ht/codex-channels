export type GatewaySettingActivation =
  | "none"
  | "restart-gateway"
  | "restart-webui"
  | "restart-all"
  | "reinstall-services";

export type StableGatewayActivation = "none" | "reload" | "restart" | "reinstall-required" | "failed";

import type { ConfigActivationResult } from "./config-activation-result.mjs";

export function normalizeGatewayActivation(activation: GatewaySettingActivation | string): StableGatewayActivation;

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
  };
  system: {
    approvalTimeoutSeconds: number;
    idleReleaseMinutes: number;
    sandbox: "read-only" | "workspace-write";
    defaultWorkspace: string | null;
    defaultModel: string | null;
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
    pluginApiEnabled: boolean;
  };
  telegram: { configured: boolean; messageFormat: "html" | "rich" };
  webui: {
    host: "127.0.0.1" | "::1" | "0.0.0.0";
    port: number;
    tokenConfigured: boolean;
  };
  metrics: {
    storage: { retentionDays: number; maxRows: number };
  };
  workspaces: Array<{
    id: string;
    name: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access" | null;
    approvalPolicy: "untrusted" | "on-request" | "never" | null;
    permissions: string | null;
  }>;
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
  | { kind: "telegram.message-format"; value: "html" | "rich" }
  | { kind: "system.approval-timeout"; value: number }
  | { kind: "system.idle-release-minutes"; value: number }
  | { kind: "system.sandbox"; value: "read-only" | "workspace-write" }
  | { kind: "system.default-workspace"; value: string }
  | { kind: "system.default-model"; value: string | null }
  | {
      kind: "system.official-tui-identity";
      value: {
        clientIdentity: {
          name?: string;
          title?: string;
          version?: string;
        } | null;
        upstreamUserAgent: string | null;
      };
    }
  | { kind: "automation.scheduled-tasks"; value: boolean }
  | { kind: "advanced.logging-level"; value: GatewaySettings["advanced"]["loggingLevel"] }
  | { kind: "advanced.plugin-api"; value: boolean }
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
  | { kind: "webui.host"; value: "127.0.0.1" | "::1" | "0.0.0.0" | null; token?: string }
  | { kind: "webui.port"; value: number | null }
  | { kind: "webui.token"; action: "set" | "clear"; value?: string }
  | { kind: "metrics.storage"; retentionDays: number; maxRows: number }
  | {
      kind: "workspace.permissions";
      workspaceId: string;
      update:
        | { kind: "sandbox"; value: "read-only" | "workspace-write" | "danger-full-access" | null }
        | { kind: "approval"; value: "untrusted" | "on-request" | "never" | null }
        | { kind: "permissions"; value: string | null };
    };

export function loadGatewaySettings(environment?: NodeJS.ProcessEnv): GatewaySettings;

export function validateNetworkProxyValue(
  field: "http_proxy" | "https_proxy" | "all_proxy" | "no_proxy" | string,
  value: unknown,
): string | undefined;

export function updateGatewaySetting(
  input: GatewaySettingInput,
  options: {
    environment?: NodeJS.ProcessEnv;
    expectedRevision: string;
    readConfig?: (configPath: string, encoding: "utf8") => string;
    writeConfig?: (configPath: string, document: unknown) => void;
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
};
