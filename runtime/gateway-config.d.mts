import type { TomlTable } from "smol-toml";

export function isTelegramEnabled(telegram: { enabled?: boolean; bot_token?: string } | undefined): boolean;

export interface QqGroupConfig {
  group_openid: string;
  allowed_member_openids: string[];
  allow_public_output: true;
}
interface QqRuntimeAccount {
  appId: string;
  appSecret: string;
  allowedUserOpenIds: Iterable<string>;
  groups?: readonly {
    groupOpenId: string;
    allowedMemberOpenIds: Iterable<string>;
    allowPublicOutput: true;
  }[];
}
export function classifyQqConfigChanges(
  current: QqRuntimeAccount | undefined,
  next: QqRuntimeAccount | undefined,
): Array<{ kind: "enabled" | "account" | "credentials" | "allowed-users" | "groups"; restart: boolean }>;

export interface GatewayConfigDocument {
  version: 1;
  default_workspace: string;
  telegram?: {
    enabled?: boolean;
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
  qq?: {
    enabled: false;
    app_id?: string;
    app_secret?: string;
    allowed_user_openids?: string[];
    groups?: QqGroupConfig[];
  } | {
    enabled: true;
    app_id: string;
    app_secret: string;
    allowed_user_openids: string[];
    groups?: QqGroupConfig[];
  };
  codex: {
    binary: string;
    socket_path: string;
    default_model?: string;
    client_identity?: {
      name?: string;
      title?: string;
      version?: string;
    };
    follow_cli_version?: boolean;
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
  model_relay?: import("./model-relay-config.mjs").ModelRelayConfig;
  conversation: { idle_release_minutes: number };
  display: {
    operation_updates: "full" | "compact" | "failures" | "hidden";
    subagents?: boolean;
    streaming?: boolean;
    plan_updates: boolean;
    reasoning: boolean;
    completion?: "off" | "brief" | "detailed";
    presentation_detail?: "basic" | "detailed";
    overrides?: readonly import("./message-display-policy.mjs").MessageDisplayOverride[];
    model_aliases?: Record<string, string>;
  };
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
    enabled?: boolean;
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
  }>;
}

export class GatewayConfigConflictError extends Error {}
/** The operation returned successfully; its result does not imply a file commit. */
export class GatewayConfigLockReleaseError<T = unknown> extends Error {
  constructor(result: T, cause: unknown);
  readonly result: T;
}
/** The destination was atomically replaced before lock or staging cleanup failed. */
export class GatewayConfigWriteCommittedError extends Error {
  constructor(cause: unknown);
}
export class GatewayConfigValidationError extends Error {
  constructor(message: string, issues: readonly { path: readonly PropertyKey[]; code: string }[]);
  readonly issues: { path: PropertyKey[]; code: string }[];
}

export function parseGatewayConfig(content: string, source?: string): TomlTable;
export const terminalIdentityPattern: RegExp;
export const officialTuiUserAgentPattern: RegExp;
export const timezonePattern: RegExp;
export function tomlErrorSummary(error: unknown): string;
export function validateGatewayConfigDocument(document: unknown): GatewayConfigDocument;
export function validateGatewayConfigStructureDocument(document: unknown): GatewayConfigDocument;
export function validateCodexConfigDocument(document: unknown): GatewayConfigDocument["codex"];
export function validateGatewayProcessConfigDocument(document: unknown): { timezone?: string };
export function validateWebuiConfigDocument(
  document: unknown,
): {
  enabled?: boolean;
  host: "127.0.0.1" | "::1" | "0.0.0.0";
  port: number;
  token?: string;
};
export function webuiServiceEnabled(document: unknown): boolean | undefined;
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
export function writeGatewayConfig(configPath: string, document: TomlTable, options?: { maximumBytes?: number }): void;
export function withGatewayConfigLock<T>(
  configPath: string,
  operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T;
