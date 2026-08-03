import type { TomlTable } from "smol-toml";

export interface GatewayConfigDocument {
  version: 1;
  default_workspace: string;
  telegram: {
    bot_token: string;
    allowed_user_ids: number[];
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
  };
  api_providers: Array<{
    id: string;
    name: string;
    protocol: "responses";
    endpoint: string;
  }>;
  vision:
    | { mode: "disabled" }
    | {
        mode: "responses_api";
        provider: string;
        model: string;
      };
  storage: { database_path: string };
  logging: { level: "fatal" | "error" | "warn" | "info" | "debug" | "trace" };
  workspaces: Array<{ id: string; name: string; cwd: string }>;
}

export function parseGatewayConfig(content: string, source?: string): TomlTable;
export function tomlErrorSummary(error: unknown): string;
export function validateGatewayConfigDocument(document: unknown): GatewayConfigDocument;
export function readGatewayConfig(configPath: string): TomlTable;
export function materializeGatewayConfigDefaults(
  configPath: string,
  document: TomlTable,
): boolean;
export function writeGatewayConfig(configPath: string, document: TomlTable): void;
