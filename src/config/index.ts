import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import "dotenv/config";
import { parse as parseDotenv } from "dotenv";
import { z } from "zod";

export {
  configChange,
  includesConfigChange,
  type ConfigChange,
  type ConfigChangeCode,
  type ConfigChangeScope,
} from "./config-change.js";

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_IDS: z.string().min(1),
  TELEGRAM_PROXY_URL: z.string().optional(),
  TELEGRAM_MESSAGE_FORMAT: z.enum(["html", "rich"]).default("html"),
  HTTPS_PROXY: z.string().optional(),
  https_proxy: z.string().optional(),
  HTTP_PROXY: z.string().optional(),
  http_proxy: z.string().optional(),
  CODEX_BINARY: z.string().min(1).default("codex"),
  CODEX_WORKSPACES_JSON: z.string().min(1),
  CODEX_DEFAULT_WORKSPACE: z.string().min(1),
  CODEX_SOCKET_PATH: z.string().min(1).optional(),
  CODEX_MODEL: z.string().optional(),
  CODEX_SANDBOX: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
  STATE_DATABASE_PATH: z.string().min(1).optional(),
  APPROVAL_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const workspaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(64),
  cwd: z.string().trim().min(1),
});

export interface GatewayConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: ReadonlySet<number>;
  telegramProxyUrl?: string;
  telegramMessageFormat: "html" | "rich";
  codexBinary: string;
  workspaces: Array<z.infer<typeof workspaceSchema>>;
  defaultWorkspaceId: string;
  codexSocketPath: string;
  codexModel?: string;
  codexSandbox: "read-only" | "workspace-write";
  stateDatabasePath: string;
  approvalTimeoutMs: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

export class ConfigurationError extends Error {}

export interface RuntimeGatewayConfig {
  config: GatewayConfig;
  envPath?: string;
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeGatewayConfig {
  const configuredPath = environment.CODEX_CONNECT_ENV_FILE?.trim();
  if (!configuredPath) {
    return { config: loadConfig(environment) };
  }
  const envPath = resolve(configuredPath);
  const fileEnvironment = parseDotenv(readFileSync(envPath, "utf8"));
  return {
    config: loadConfig(fileEnvironment),
    envPath,
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (Object.hasOwn(environment, "CODEX_BRIDGE_SANDBOX")) {
    throw new ConfigurationError("不支持配置项 CODEX_BRIDGE_SANDBOX；请改用 CODEX_SANDBOX");
  }
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(z.prettifyError(parsed.error));
  }

  const raw = parsed.data;
  let workspaceInput: unknown;
  try {
    workspaceInput = JSON.parse(raw.CODEX_WORKSPACES_JSON);
  } catch {
    throw new ConfigurationError("CODEX_WORKSPACES_JSON 必须是有效 JSON");
  }
  const parsedWorkspaces = z.array(workspaceSchema).min(1).safeParse(workspaceInput);
  if (!parsedWorkspaces.success) {
    throw new ConfigurationError(`CODEX_WORKSPACES_JSON 无效：${z.prettifyError(parsedWorkspaces.error)}`);
  }
  const workspaceIds = new Set<string>();
  const workspaces = parsedWorkspaces.data.map((workspace) => {
    if (workspaceIds.has(workspace.id)) {
      throw new ConfigurationError(`Workspace ID 重复：${workspace.id}`);
    }
    workspaceIds.add(workspace.id);
    if (!isAbsolute(workspace.cwd)) {
      throw new ConfigurationError(`Workspace ${workspace.id} 的 cwd 必须是绝对路径`);
    }
    if (!existsSync(workspace.cwd)) {
      throw new ConfigurationError(`Workspace ${workspace.id} 的 cwd 必须是已存在的目录`);
    }
    const cwd = realpathSync(workspace.cwd);
    if (!statSync(cwd).isDirectory()) {
      throw new ConfigurationError(`Workspace ${workspace.id} 的 cwd 必须是目录`);
    }
    return { ...workspace, cwd };
  });
  if (!workspaceIds.has(raw.CODEX_DEFAULT_WORKSPACE)) {
    throw new ConfigurationError(`CODEX_DEFAULT_WORKSPACE 不存在：${raw.CODEX_DEFAULT_WORKSPACE}`);
  }

  const allowedIds = new Set<number>();
  for (const value of raw.TELEGRAM_ALLOWED_USER_IDS.split(",")) {
    const id = Number(value.trim());
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ConfigurationError(`无效的 TELEGRAM_ALLOWED_USER_IDS：${value}`);
    }
    allowedIds.add(id);
  }

  const socketPath = resolve(
    raw.CODEX_SOCKET_PATH ?? resolve(".runtime/codex-app-server.sock"),
  );
  if (!isAbsolute(socketPath)) {
    throw new ConfigurationError("CODEX_SOCKET_PATH 必须解析为绝对路径");
  }
  const proxyUrl = normalizeProxyUrl(
    raw.TELEGRAM_PROXY_URL ?? raw.HTTPS_PROXY ?? raw.https_proxy ?? raw.HTTP_PROXY ?? raw.http_proxy,
  );

  return {
    telegramBotToken: raw.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: allowedIds,
    ...(proxyUrl ? { telegramProxyUrl: proxyUrl } : {}),
    telegramMessageFormat: raw.TELEGRAM_MESSAGE_FORMAT,
    codexBinary: raw.CODEX_BINARY,
    workspaces,
    defaultWorkspaceId: raw.CODEX_DEFAULT_WORKSPACE,
    codexSocketPath: socketPath,
    ...(raw.CODEX_MODEL ? { codexModel: raw.CODEX_MODEL } : {}),
    codexSandbox: raw.CODEX_SANDBOX,
    stateDatabasePath: resolve(raw.STATE_DATABASE_PATH ?? "data/gateway.sqlite3"),
    approvalTimeoutMs: raw.APPROVAL_TIMEOUT_SECONDS * 1000,
    logLevel: raw.LOG_LEVEL,
  };
}

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new ConfigurationError("TELEGRAM_PROXY_URL/HTTPS_PROXY 不是有效 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError("Telegram 代理目前只支持 http:// 或 https://");
  }
  return parsed.toString();
}
