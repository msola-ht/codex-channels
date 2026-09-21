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
  codex: {
    binary: string;
    socket_path: string;
    default_model?: string;
    sandbox: "read-only" | "workspace-write";
    client_identity?: {
      name?: string;
      title?: string;
      version?: string;
    };
    upstream_user_agent?: string;
    terminal_identity?: string;
    timezone?: string;
    desktop_app?: {
      enabled: boolean;
      port: number;
    };
  };
  approval: { timeout_seconds: number };
  gateway?: { timezone?: string };
  conversation: { idle_release_minutes: number };
  display: {
    operation_updates: "full" | "compact" | "hidden";
    plan_updates: boolean;
    reasoning: boolean;
  };
  experimental: { plugin_api: boolean };
  debug?: {
    model_traffic_dump: boolean;
    model_traffic_input_items: number;
    model_traffic_item_max_bytes: number;
    model_traffic_retention_days: number;
  };
  scheduled_tasks: { enabled: boolean };
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
export const terminalIdentityPattern: RegExp;
export const timezonePattern: RegExp;
export function tomlErrorSummary(error: unknown): string;
export function validateGatewayConfigDocument(document: unknown): GatewayConfigDocument;
export function validateCodexConfigDocument(document: unknown): GatewayConfigDocument["codex"];
export function validateGatewayProcessConfigDocument(document: unknown): { timezone?: string };
export function validateWebuiConfigDocument(
  document: unknown,
): {
  host: "127.0.0.1" | "::1" | "0.0.0.0";
  port: number;
  token?: string;
};
export function validateDebugConfigDocument(
  document: unknown,
): {
  model_traffic_dump: boolean;
  model_traffic_input_items: number;
  model_traffic_item_max_bytes: number;
  model_traffic_retention_days: number;
};
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
