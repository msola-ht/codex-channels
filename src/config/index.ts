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
  workspaces: ConfiguredWorkspace[];
  defaultWorkspaceId: string;
  codexSocketPath: string;
  codexModel?: string;
  codexSandbox: "read-only" | "workspace-write";
  operationUpdateDisplay: OperationUpdateDisplay;
  planUpdatesEnabled: boolean;
  priceCurrency: "cny" | "usd";
  apiProviders: ReadonlyArray<{
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
        endpoint: string;
        model: string;
        timeoutMs: number;
      };
  credentialsDirectory: string;
  stateDatabasePath: string;
  approvalTimeoutMs: number;
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  webui?: {
    host: "127.0.0.1" | "::1" | "0.0.0.0";
    port: number;
    token?: string;
  };
  metricsSync?: {
    enabled: boolean;
    endpoint?: string;
    deviceToken?: string;
    deviceId?: string;
    batchSize: number;
    intervalSeconds: number;
  };
  metricsCenter?: {
    enabled: boolean;
    host: "127.0.0.1" | "::1" | "0.0.0.0";
    port: number;
    token?: string;
    databasePath: string;
  };
  metricsView?: {
    enabled: boolean;
    endpoint?: string;
    token?: string;
  };
}

export interface ConfiguredWorkspace {
  id: string;
  name: string;
  cwd: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-request" | "never";
  permissions?: string;
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
    priceCurrency: raw.display.price_currency,
    apiProviders: raw.api_providers.map(toApiProviderConfig),
    vision: toVisionConfig(raw.vision, raw.api_providers),
    credentialsDirectory: resolve(baseDirectory, "credentials"),
    stateDatabasePath: resolveConfiguredPath(raw.storage.database_path, baseDirectory),
    approvalTimeoutMs: raw.approval.timeout_seconds * 1000,
    logLevel: raw.logging.level,
    ...(raw.webui ? { webui: raw.webui } : {}),
    metricsSync: {
      enabled: raw.metrics.sync.enabled,
      ...(raw.metrics.sync.endpoint
        ? { endpoint: raw.metrics.sync.endpoint }
        : {}),
      ...(raw.metrics.sync.device_token
        ? { deviceToken: raw.metrics.sync.device_token }
        : {}),
      ...(raw.metrics.sync.device_id
        ? { deviceId: raw.metrics.sync.device_id }
        : {}),
      batchSize: raw.metrics.sync.batch_size ?? 200,
      intervalSeconds: raw.metrics.sync.interval_seconds ?? 60,
    },
    ...(raw.metrics.center
      ? {
          metricsCenter: {
            enabled: raw.metrics.center.enabled,
            host: raw.metrics.center.host,
            port: raw.metrics.center.port,
            ...(raw.metrics.center.token
              ? { token: raw.metrics.center.token }
              : {}),
            databasePath: raw.metrics.center.database_path,
          },
        }
      : {}),
    ...(raw.metrics.view
      ? {
          metricsView: {
            enabled: raw.metrics.view.enabled,
            ...(raw.metrics.view.endpoint
              ? { endpoint: raw.metrics.view.endpoint }
              : {}),
            ...(raw.metrics.view.token
              ? { token: raw.metrics.view.token }
              : {}),
          },
        }
      : {}),
  };
}

function toApiProviderConfig(
  raw: GatewayConfigDocument["api_providers"][number],
): GatewayConfig["apiProviders"][number] {
  return {
    ...raw,
    endpoint: validateApiEndpoint(raw.endpoint, `api_providers.${raw.id}.endpoint`),
  };
}

function toVisionConfig(
  raw: GatewayConfigDocument["vision"],
  providers: GatewayConfigDocument["api_providers"],
): GatewayConfig["vision"] {
  if (raw.mode === "disabled") return raw;
  const provider = providers.find((candidate) => candidate.id === raw.provider);
  if (!provider) {
    throw new ConfigurationError(`vision.provider 不存在：${raw.provider}`);
  }
  return {
    mode: raw.mode,
    provider: provider.id,
    endpoint: validateApiEndpoint(provider.endpoint, `api_providers.${provider.id}.endpoint`),
    model: raw.model,
    timeoutMs: raw.timeout_seconds * 1000,
  };
}

function validateApiEndpoint(value: string, field: string): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ConfigurationError(`${field} 必须是有效 URL`);
  }
  const loopback = endpoint.hostname === "localhost"
    || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new ConfigurationError(`${field} 必须使用 HTTPS；本机回环地址可以使用 HTTP`);
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new ConfigurationError(`${field} 不能包含凭据、Query 或 URL Fragment`);
  }
  return endpoint.toString();
}

function validateWorkspaces(
  parsedWorkspaces: GatewayConfigDocument["workspaces"],
): ConfiguredWorkspace[] {
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
    return {
      id: workspace.id,
      name: workspace.name,
      cwd,
      ...(workspace.sandbox === undefined
        ? {}
        : { sandbox: workspace.sandbox }),
      ...(workspace.approval_policy === undefined
        ? {}
        : { approvalPolicy: workspace.approval_policy }),
      ...(workspace.permissions === undefined
        ? {}
        : { permissions: workspace.permissions }),
    };
  });
}

function resolveConfiguredPath(value: string, baseDirectory: string): string {
  return isAbsolute(value) ? resolve(value) : resolve(baseDirectory, value);
}
