import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

import {
  materializeGatewayConfigDefaults,
  parseGatewayConfig,
  validateGatewayConfigDocument,
  type GatewayConfigDocument,
} from "../../runtime/gateway-config.mjs";
import {
  resolveHttpProxyUrl,
  resolveProxyEnvironment,
} from "../../runtime/network-proxy.mjs";

export {
  configChange,
  includesConfigChange,
  type ConfigChange,
  type ConfigChangeCode,
  type ConfigChangeScope,
  type FeishuConfigChangeCode,
  type GlobalConfigChangeCode,
  type TelegramConfigChangeCode,
  type WeixinConfigChangeCode,
} from "./config-change.js";
export {
  classifyConfigReload,
  type ConfigReloadResult,
} from "./reload-classifier.js";

export interface GatewayConfig {
  telegramBotToken: string;
  telegramAllowedUserIds: ReadonlySet<number>;
  telegramProxyUrl?: string;
  telegramMessageFormat: "html" | "rich";
  feishu?: {
    appId: string;
    appSecret: string;
    allowedOpenIds: ReadonlySet<string>;
  };
  weixin?: {
    accountId: string;
    allowedUserIds: ReadonlySet<string>;
  };
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
  operationUpdateDisplay: OperationUpdateDisplay;
  planUpdatesEnabled: boolean;
  vision:
    | { mode: "disabled" }
    | {
        mode: "responses_api";
        endpoint: string;
        model: string;
      };
  credentialsDirectory: string;
  stateDatabasePath: string;
  approvalTimeoutMs: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
}

export type OperationUpdateDisplay = "full" | "compact" | "hidden";

export function isDebugLogLevel(
  level: GatewayConfig["logLevel"],
): boolean {
  return level === "debug" || level === "trace";
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
  validateRuntimeConfigPermissions(configPath);
  const documents = parseConfigDocuments(readFileSync(configPath, "utf8"));
  const config = loadValidatedConfigDocument(
    documents.validated,
    dirname(configPath),
    { environment, detectSystemProxy: true },
  );
  try {
    materializeGatewayConfigDefaults(configPath, documents.source);
  } catch {
    throw new ConfigurationError(
      "config.toml 安全默认值自动补齐失败，请检查文件权限后重试",
    );
  }
  return { config, configPath };
}

function validateRuntimeConfigPermissions(configPath: string): void {
  let configStatus: ReturnType<typeof lstatSync>;
  let parentStatus: ReturnType<typeof lstatSync>;
  try {
    configStatus = lstatSync(configPath);
    parentStatus = lstatSync(dirname(configPath));
  } catch {
    throw new ConfigurationError("config.toml 不可用，请检查文件路径和权限");
  }
  if (!configStatus.isFile()) {
    throw new ConfigurationError("config.toml 必须是普通文件且不能是符号链接");
  }
  const currentUserId = process.getuid?.();
  if (
    currentUserId !== undefined
    && (configStatus.uid !== currentUserId || parentStatus.uid !== currentUserId)
  ) {
    throw new ConfigurationError("config.toml 及其父目录必须由当前用户拥有");
  }
  if ((configStatus.mode & 0o077) !== 0) {
    throw new ConfigurationError(
      "config.toml 权限不安全：不能允许组或其他用户访问",
    );
  }
  if (!parentStatus.isDirectory() || (parentStatus.mode & 0o022) !== 0) {
    throw new ConfigurationError(
      "config.toml 父目录权限不安全：不能允许组或其他用户写入",
    );
  }
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
  const documents = parseConfigDocuments(content);
  return loadValidatedConfigDocument(
    documents.validated,
    baseDirectory,
    { environment, detectSystemProxy },
  );
}

function parseConfigDocuments(content: string): {
  source: ReturnType<typeof parseGatewayConfig>;
  validated: GatewayConfigDocument;
} {
  let document: GatewayConfigDocument;
  let source: ReturnType<typeof parseGatewayConfig>;
  try {
    source = parseGatewayConfig(content);
    document = validateGatewayConfigDocument(source);
  } catch (error) {
    throw new ConfigurationError(
      error instanceof Error ? error.message : String(error),
    );
  }
  return { source, validated: document };
}

function loadValidatedConfigDocument(
  raw: GatewayConfigDocument,
  baseDirectory: string,
  {
    environment = {},
    detectSystemProxy = false,
  }: {
    environment?: NodeJS.ProcessEnv;
    detectSystemProxy?: boolean;
  } = {},
): GatewayConfig {
  const workspaces = validateWorkspaces(raw.workspaces);
  if (!workspaces.some((workspace) => workspace.id === raw.default_workspace)) {
    throw new ConfigurationError(`default_workspace 不存在：${raw.default_workspace}`);
  }
  const proxyEnvironment = resolveProxyEnvironment(
    raw.network,
    environment,
    detectSystemProxy ? {} : { readSystemProxy: () => ({}) },
  );
  let proxyUrl: string | undefined;
  try {
    proxyUrl = resolveHttpProxyUrl(raw.telegram.proxy_url);
  } catch (error) {
    throw new ConfigurationError(error instanceof Error ? error.message : String(error));
  }
  return {
    telegramBotToken: raw.telegram.bot_token,
    telegramAllowedUserIds: new Set(raw.telegram.allowed_user_ids),
    ...(proxyUrl ? { telegramProxyUrl: proxyUrl } : {}),
    telegramMessageFormat: raw.telegram.message_format,
    ...(raw.feishu?.enabled
      ? {
          feishu: {
            appId: raw.feishu.app_id,
            appSecret: raw.feishu.app_secret,
            allowedOpenIds: new Set(raw.feishu.allowed_open_ids),
          },
        }
      : {}),
    ...(raw.weixin?.enabled
      ? {
          weixin: {
            accountId: raw.weixin.account_id,
            allowedUserIds: new Set(raw.weixin.allowed_user_ids),
          },
        }
      : {}),
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
    operationUpdateDisplay: raw.display.operation_updates,
    planUpdatesEnabled: raw.display.plan_updates,
    vision: toVisionConfig(raw.vision),
    credentialsDirectory: resolve(baseDirectory, "credentials"),
    stateDatabasePath: resolveConfiguredPath(raw.storage.database_path, baseDirectory),
    approvalTimeoutMs: raw.approval.timeout_seconds * 1000,
    logLevel: raw.logging.level,
  };
}

function toVisionConfig(raw: GatewayConfigDocument["vision"]): GatewayConfig["vision"] {
  if (raw.mode === "disabled") return raw;
  let endpoint: URL;
  try {
    endpoint = new URL(raw.endpoint);
  } catch {
    throw new ConfigurationError("vision.endpoint 必须是有效 URL");
  }
  const loopback = endpoint.hostname === "localhost"
    || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new ConfigurationError("vision.endpoint 必须使用 HTTPS；本机回环地址可以使用 HTTP");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new ConfigurationError("vision.endpoint 不能包含凭据或 URL Fragment");
  }
  return {
    mode: raw.mode,
    endpoint: endpoint.toString(),
    model: raw.model,
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
