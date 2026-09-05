import type { TomlTable } from "smol-toml";

export interface GatewayConfigDocument {
  version: 1;
  default_workspace: string;
  telegram?: {
    bot_token?: string;
    allowed_user_ids?: number[];
    proxy_url?: string;
    message_format: "html" | "rich";
  };
  feishu?: {
    enabled: false;
    app_id?: string;
    app_secret?: string;
    allowed_open_ids?: string[];
  } | {
    enabled: true;
    app_id: string;
    app_secret: string;
    allowed_open_ids: string[];
  };
  weixin?: {
    enabled: boolean;
    account_id: string;
    allowed_user_ids: string[];
  };
  network?: {
    http_proxy?: string;
    https_proxy?: string;
    all_proxy?: string;
    no_proxy?: string;
  };
  codex: {
    binary: string;
    socket_path: string;
    default_model?: string;
    sandbox: "read-only" | "workspace-write";
  };
  approval: { timeout_seconds: number };
  display: {
    operation_updates: "full" | "compact" | "hidden";
    plan_updates: boolean;
    reasoning: boolean;
    price_currency: "cny" | "usd";
  };
  experimental: { plugin_api: boolean };
  scheduled_tasks: { enabled: boolean };
  api_providers: Array<{
    id: string;
    name: string;
    protocol: "responses";
    endpoint: string;
  }>;
  storage: { database_path: string };
  logging: { level: "fatal" | "error" | "warn" | "info" | "debug" | "trace" };
  webui?: {
    host: "127.0.0.1" | "::1" | "0.0.0.0";
    port: number;
    token?: string;
  };
  metrics: {
    storage: {
      retention_days: number;
      max_rows: number;
    };
    sync: {
      enabled: boolean;
      endpoint?: string;
      device_token?: string;
      device_id?: string;
      device_name?: string;
      batch_size: number;
      interval_seconds: number;
    };
    center?: {
      enabled: boolean;
      host: "127.0.0.1" | "::1" | "0.0.0.0";
      port: number;
      token?: string;
      device_token?: string;
      database_path: string;
    };
    view?: {
      enabled: boolean;
      endpoint?: string;
      token?: string;
    };
  };
  workspaces: Array<{
    id: string;
    name: string;
    cwd: string;
    sandbox?: "read-only" | "workspace-write" | "danger-full-access";
    approval_policy?: "untrusted" | "on-request" | "never";
    permissions?: string;
  }>;
}

export class GatewayConfigConflictError extends Error {}

export function parseGatewayConfig(content: string, source?: string): TomlTable;
export function tomlErrorSummary(error: unknown): string;
export function validateGatewayConfigDocument(document: unknown): GatewayConfigDocument;
export function validateCodexConfigDocument(document: unknown): GatewayConfigDocument["codex"];
export function validateWebuiConfigDocument(
  document: unknown,
): {
  host: "127.0.0.1" | "::1" | "0.0.0.0";
  port: number;
  token?: string;
};
export function validateMetricsCenterConfigDocument(
  document: unknown,
): {
  enabled: boolean;
  host: "127.0.0.1" | "::1" | "0.0.0.0";
  port: number;
  token?: string;
  device_token?: string;
  database_path: string;
};
export function validateMetricsViewConfigDocument(
  document: unknown,
): {
  enabled: boolean;
  endpoint?: string;
  token?: string;
};
export function isPrivateHttpEndpoint(url: URL): boolean;
export function readGatewayConfig(configPath: string): TomlTable;
export function materializeGatewayConfigDefaults(
  configPath: string,
  document: TomlTable,
): boolean;
export function writeGatewayConfig(configPath: string, document: TomlTable): void;
export function withGatewayConfigLock<T>(
  configPath: string,
  operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T;
