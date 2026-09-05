export type GatewaySettingActivation =
  | "none"
  | "restart-gateway"
  | "restart-gateway-webui"
  | "restart-webui"
  | "restart-center"
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
    sync: {
      enabled: boolean;
      endpoint: string | null;
      deviceId: string | null;
      deviceName: string | null;
      deviceTokenConfigured: boolean;
      intervalSeconds: number;
      batchSize: number;
    };
    view: { enabled: boolean; endpoint: string | null; tokenConfigured: boolean };
    center: {
      enabled: boolean;
      host: "127.0.0.1" | "::1" | "0.0.0.0";
      port: number;
      tokenConfigured: boolean;
      deviceTokenConfigured: boolean;
      databasePath: string;
    };
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
  | { kind: "display.price-currency"; value: "cny" | "usd" }
  | { kind: "telegram.message-format"; value: "html" | "rich" }
  | { kind: "system.approval-timeout"; value: number }
  | { kind: "system.sandbox"; value: "read-only" | "workspace-write" }
  | { kind: "system.default-workspace"; value: string }
  | { kind: "system.default-model"; value: string | null }
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
  | { kind: "metrics.sync-params"; intervalSeconds?: number; batchSize?: number; deviceName?: string | null }
  | {
      kind: "metrics.connect";
      endpoint: string;
      deviceToken: string;
      viewToken: string;
      deviceId?: string | null;
      deviceName?: string | null;
    }
  | { kind: "metrics.disconnect" }
  | {
      kind: "metrics.center.host";
      value: "127.0.0.1" | "::1" | "0.0.0.0" | null;
      token?: string;
      deviceToken?: string;
    }
  | { kind: "metrics.center.port"; value: number | null }
  | {
      kind: "metrics.center.token";
      field: "token" | "device_token";
      action: "set" | "clear";
      value?: string;
    }
  | { kind: "metrics.center.generate-tokens" }
  | { kind: "metrics.center.database-path"; value: string | null }
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
  generatedTokens?: { viewToken: string; deviceToken: string };
};
