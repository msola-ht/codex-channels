import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  parseGatewayConfig,
  validateGatewayConfigDocument,
  type GatewayConfigDocument,
} from "../../runtime/gateway-config.mjs";
import { resolveProxyEnvironment } from "../../runtime/network-proxy.mjs";

export {
  configChange,
  includesConfigChange,
  type ConfigChange,
  type ConfigChangeCode,
  type ConfigChangeScope,
} from "./config-change.js";

export interface GatewayConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: ReadonlySet<number>;
  telegramProxyUrl?: string;
  telegramMessageFormat: "html" | "rich";
  codexBinary: string;
  networkProxy: {
    http?: string;
    https?: string;
    all?: string;
    no?: string;
  };
  workspaces: GatewayConfigDocument["workspaces"];
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
  configPath: string;
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeGatewayConfig {
  const configuredPath = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = resolve(
    configuredPath
      || resolve(environment.CODEX_CONNECT_HOME?.trim() || resolve(homedir(), ".codex-connect"), "config.toml"),
  );
  return {
    config: loadConfigDocument(
      readFileSync(configPath, "utf8"),
      dirname(configPath),
      { environment, detectSystemProxy: true },
    ),
    configPath,
  };
}

export function loadConfigDocument(
  content: string,
  baseDirectory: string,
  {
    environment = {},
    detectSystemProxy = false,
  }: {
    environment?: NodeJS.ProcessEnv;
    detectSystemProxy?: boolean;
  } = {},
): GatewayConfig {
  let document: GatewayConfigDocument;
  try {
    document = validateGatewayConfigDocument(parseGatewayConfig(content));
  } catch (error) {
    throw new ConfigurationError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const raw = document;
  const workspaces = validateWorkspaces(raw.workspaces);
  if (!workspaces.some((workspace) => workspace.id === raw.default_workspace)) {
    throw new ConfigurationError(`default_workspace 不存在：${raw.default_workspace}`);
  }
  const proxyEnvironment = resolveProxyEnvironment(
    raw.network,
    environment,
    detectSystemProxy ? {} : { readSystemProxy: () => ({}) },
  );
  const proxyUrl = normalizeProxyUrl(
    raw.telegram.proxy_url || proxyEnvironment.HTTPS_PROXY || proxyEnvironment.HTTP_PROXY,
  );
  return {
    telegramBotToken: raw.telegram.bot_token,
    telegramAllowedUserIds: new Set(raw.telegram.allowed_user_ids),
    ...(proxyUrl ? { telegramProxyUrl: proxyUrl } : {}),
    telegramMessageFormat: raw.telegram.message_format,
    codexBinary: raw.codex.binary,
    networkProxy: {
      ...(proxyEnvironment.HTTP_PROXY ? { http: proxyEnvironment.HTTP_PROXY } : {}),
      ...(proxyEnvironment.HTTPS_PROXY ? { https: proxyEnvironment.HTTPS_PROXY } : {}),
      ...(proxyEnvironment.ALL_PROXY ? { all: proxyEnvironment.ALL_PROXY } : {}),
      ...(proxyEnvironment.NO_PROXY ? { no: proxyEnvironment.NO_PROXY } : {}),
    },
    workspaces,
    defaultWorkspaceId: raw.default_workspace,
    codexSocketPath: resolveConfiguredPath(raw.codex.socket_path, baseDirectory),
    ...(raw.codex.default_model ? { codexModel: raw.codex.default_model } : {}),
    codexSandbox: raw.codex.sandbox,
    stateDatabasePath: resolveConfiguredPath(raw.storage.database_path, baseDirectory),
    approvalTimeoutMs: raw.approval.timeout_seconds * 1000,
    logLevel: raw.logging.level,
  };
}

function validateWorkspaces(
  parsedWorkspaces: GatewayConfigDocument["workspaces"],
): GatewayConfigDocument["workspaces"] {
  const workspaceIds = new Set<string>();
  return parsedWorkspaces.map((workspace) => {
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
}

function resolveConfiguredPath(value: string, baseDirectory: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
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
    throw new ConfigurationError("telegram.proxy_url/network 代理不是有效 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError("Telegram 代理目前只支持 http:// 或 https://");
  }
  return parsed.toString();
}
