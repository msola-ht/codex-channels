import { closeQueueStreams, openQueueStream } from "./webui-queue-events.mjs";
import { watchQueueChanges } from "../runtime/queue-events.mjs";
import { installServiceControlHandler } from "../runtime/process-lifecycle.mjs";
import { serviceShutdownTimeoutMs } from "../runtime/shutdown-budget.mjs";
import { accountSnapshotEventsPath, metricsEventsPath } from "../runtime/metrics-events.mjs";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { metricsRangeOptions } from "./metrics-command-options.mjs";
import { createMetricsExportOwner } from "./metrics-export-stream.mjs";
import { MetricsExportError } from "./metrics-export-limits.mjs";
import { createMetricsReadOwner, MetricsReadError } from "./webui-metrics-read.mjs";
import { closeDeliveryReaders, waitForDeliveryReadersExit, closeDeliveryJournals, waitForDeliveryJournalsExit } from "../dist/delivery/index.js";
import { closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "../runtime/windows-acl-bridge.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { userDataDir } from "./runtime-config.mjs";
import { GatewayConfigWriteCommittedError } from "../runtime/gateway-config.mjs";
import {
  assertWebuiHost,
  parseWebuiCliArgs,
} from "./webui-command-options.mjs";
import {
  readGatewayConfig,
  parseGatewayConfig,
  validateGatewayConfigStructureDocument,
  validateWebuiConfigDocument,
} from "../runtime/gateway-config.mjs";
import { readPrivateConfigFile } from "../runtime/private-file.mjs";
import { requestGatewayAccountRefresh, requestGatewayResetCredits } from "../runtime/gateway-account-refresh.mjs";
import { requestGatewayThreadStates } from "../runtime/gateway-thread-state.mjs";
import { modelRelayConfigSchema } from "../runtime/model-relay-config.mjs";
import {
  parseRequestMetricsFilters,
} from "../dist/observability/index.js";
import {
  ConfigManagementError,
  loadGatewaySettings,
} from "./config-management.mjs";
import { loadModelProviderManagementState } from "./model-provider-management.mjs";
import { closeCodexUserConfigClients, createSharedCodexUserConfigClient, readCodexUserConfigSnapshot } from "./codex-user-config.mjs";
import { closeAppServerUserAgentReads } from "./webui-management-status-route.mjs";
import { invalidateServiceStatusSummary, loadServiceStatusSummary, serviceSummaryHealthy } from "./webui-service-status.mjs";
import {
  ApiError,
  authorized,
  isLoopbackAddress,
  readJsonBody,
  sendJson,
  sendManagementJson,
} from "./webui-http.mjs";
import {
  ManagementAuditWriter,
  ManagementConfirmationStore,
  ManagementRateLimiter,
  ManagementSecurityError,
  fingerprintManagementValue,
  validateManagementJsonRequest,
} from "./management-security.mjs";
import {
  loadCodexUserSettings,
  previewCodexUserSetting,
  updateCodexUserSetting,
} from "./codex-user-settings-management.mjs";
import { WebuiManagementTaskRunner } from "./webui-management-tasks.mjs";
import {
  isHighRiskManagementPath,
  ManagementOperationError,
  closeManagementSnapshotReads,
} from "./webui-management-operations.mjs";
import { routeTrafficApi, routeTrafficEvents, waitForTrafficReads } from "./webui-traffic-route.mjs";
import {
  applyProviderSettingsMutation,
  previewProviderSettingsMutation,
} from "./webui-provider-settings-management.mjs";
import {
  applyAccountSettingsMutation,
  loadAccountSettingsResource,
  previewAccountSettingsMutation,
} from "./webui-account-settings-management.mjs";
import { withModelProviderManagementTransaction } from "./model-provider-management-transaction.mjs";
import { routeCodexSettingsManagement } from "./webui-management-codex-route.mjs";
import { routeRelayManagement } from "./webui-management-relay-route.mjs";
import { routeDeliveryManagement } from "./webui-management-delivery-route.mjs";
import { routeGatewaySettingsManagement } from "./webui-management-gateway-route.mjs";
import {
  routeProviderManagement,
  sendAccountSnapshots,
} from "./webui-management-provider-route.mjs";
import { routeStatusManagement } from "./webui-management-status-route.mjs";
import { routeTaskManagement } from "./webui-management-task-route.mjs";
import { routeLogsApi } from "./webui-logs-route.mjs";
import { webuiLogger } from "./webui-logger.mjs";
import { closeOfficialModelOperations } from "./webui-management-official-model-route.mjs";
import { closeModelBaseOperations } from "./webui-management-model-base-route.mjs";

const logger = webuiLogger.child({ module: "http" });

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const API_PREFIX = "/api/v1";
const requestSortKeys = {
  time: "recordedAtMs",
  provider: "provider",
  model: "model",
  operation: "operation",
  status: "status",
  http: "httpStatus",
  error: "error",
  input: "inputTokens",
  output: "outputTokens",
  reasoningOutput: "reasoningOutputTokens",
  totalDuration: "totalDurationMs",
  requestBytes: "requestBytes",
};
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_VERSION = readJsonMetadata(join(PACKAGE_DIR, "package.json"))?.version ?? null;
const SOURCE_GATEWAY_VERSION = readJsonMetadata(join(PACKAGE_DIR, "src", "version.json"))?.version ?? null;
const GATEWAY_VERSION = PACKAGE_VERSION ?? SOURCE_GATEWAY_VERSION;
const CODEX_CLI_VERSION = (readJsonMetadata(join(PACKAGE_DIR, "src", "codex-protocol", "version.json"))?.codexCli ?? null)
  ?.replace(/^codex-cli\s+/u, "") ?? null;
const WEBUI_DOCUMENT_SECURITY_HEADERS = Object.freeze({
  "content-security-policy": "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; worker-src 'none'",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
});
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

export function createWebuiServer({
  environment = process.env,
  host = DEFAULT_HOST,
  staticDir = join(PACKAGE_DIR, "webui", "dist"),
  token = null,
  port = DEFAULT_PORT,
  managementOrigin = null,
  loadProviderState = (options) => loadModelProviderManagementState({ ...options,
    readUserConfig: (env) => readCodexUserConfigSnapshot(env, {
      createClient: createSharedCodexUserConfigClient, signal: options.signal,
    }),
  }),
  loadCodexSettings = (options) => loadCodexUserSettings({ ...options, createClient: createSharedCodexUserConfigClient }),
  previewCodexSetting = previewCodexUserSetting,
  updateCodexSetting = updateCodexUserSetting,
  previewProviderSettings = previewProviderSettingsMutation,
  applyProviderSettings = applyProviderSettingsMutation,
  previewAccountSettings = previewAccountSettingsMutation,
  applyAccountSettings = applyAccountSettingsMutation,
  loadAccountSettings = loadAccountSettingsResource,
  refreshGatewayAccount = requestGatewayAccountRefresh,
  resetGatewayCredits = requestGatewayResetCredits,
} = {}) {
  assertWebuiHost(host);
  if (host === "0.0.0.0" && (typeof token !== "string" || token.trim() === "")) {
    throw new Error(
      "WebUI 绑定非回环地址时必须提供访问令牌（请通过 codexc config 或配置 [webui] token 设置）",
    );
  }
  const serviceStatusCache = { expiresAtMs: 0, value: null, pending: null };
  const gatewayConfigRead = { pending: null, controller: null, responses: new Set() };
  const providerStateCache = { expiresAtMs: 0, value: null, pending: null };
  const metricsExports = createMetricsExportOwner();
  const metricsReads = createMetricsReadOwner();
  const management = createManagementState(
    environment,
    host,
    port,
    managementOrigin,
    serviceStatusCache,
    providerStateCache,
    loadProviderState,
    loadCodexSettings,
    previewCodexSetting,
    updateCodexSetting,
    previewProviderSettings,
    applyProviderSettings,
    previewAccountSettings,
    applyAccountSettings,
    loadAccountSettings,
    refreshGatewayAccount,
    resetGatewayCredits,
  );
  const readMetrics = (task, response) => readMetricsForResponse(metricsReads, environment, task, response, management.shutdownController.signal);
  management.readMetrics = readMetrics;
  const server = createServer((request, response) => {
    handleRequest(environment, staticDir, host, token, serviceStatusCache, gatewayConfigRead, metricsExports, readMetrics, management, request, response);
  });
  server.on("close", () => {
    gatewayConfigRead.controller?.abort();
    management.shutdownController.abort();
    void metricsReads.close().catch(() => logger.error({ event: "metrics.read-close-failed" }, "指标读取资源退出未确认"));
  });
  return { host, server, staticDir, token, closeNotifications: async () => {
    management.shutdownController.abort();
    gatewayConfigRead.controller?.abort();
    const results = await Promise.allSettled([
      Promise.resolve().then(() => closeQueueStreams(management)),
      management.tasks.close(),
      waitForTrafficReads(management.shutdownController.signal),
      metricsExports.close(), metricsReads.close(), closeDeliveryReaders(), closeDeliveryJournals(), closeWindowsAclBridge({ timeoutMs: 2_000 }),
      closeOfficialModelOperations(management),
      closeModelBaseOperations(management),
      closeAppServerUserAgentReads(management.appServerUserAgentCache),
      closeManagementSnapshotReads(management).then(() => closeCodexUserConfigClients()),
    ]);
    if (results.some(result => result.status === "rejected")) throw new Error("WebUI 后台资源退出未确认");
  }, waitForNotificationsExit: async () => {
    await waitForTrafficReads(management.shutdownController.signal);
    await Promise.all([management.tasks.waitForExit(), closeQueueStreams(management), closeAppServerUserAgentReads(management.appServerUserAgentCache), metricsExports.waitForExit(), metricsReads.waitForExit(), waitForDeliveryReadersExit(), waitForDeliveryJournalsExit(), waitForWindowsAclBridgeExit(), closeOfficialModelOperations(management, { waitForExit: true }),
      closeModelBaseOperations(management, { waitForExit: true }),
      closeManagementSnapshotReads(management).then(() => closeCodexUserConfigClients())]);
  } };
}

export function resolveWebuiSettings({
  args = [],
  environment = process.env,
} = {}) {
  const cli = parseWebuiCliArgs(args);
  const configPath = resolveGatewayConfigPath(environment);
  let configured = {};
  if (existsSync(configPath)) {
    configured = validateWebuiConfigDocument(readGatewayConfig(configPath));
  }
  return {
    host: cli.host ?? configured.host ?? DEFAULT_HOST,
    port: cli.port ?? configured.port ?? DEFAULT_PORT,
    token: cli.token !== undefined ? cli.token : configured.token ?? null,
    configPath,
  };
}

async function handleRequest(environment, staticDir, host, token, serviceStatusCache, gatewayConfigRead, metricsExports, readMetrics, management, request, response) {
  let managementRequest = false;
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const managementPrefix = `${API_PREFIX}/management`;
    managementRequest = requestUrl.pathname === managementPrefix || requestUrl.pathname.startsWith(`${managementPrefix}/`);
    if (token === null) validateAnonymousRequest(request);
    if (managementRequest) {
      await routeManagement(environment, requestUrl, request, response, management, token);
      return;
    }
    if (request.method !== "GET") {
      sendJson(response, 405, {
        error: { code: "method_not_allowed", message: "WebUI 只提供只读 GET 接口" },
      });
      return;
    }
    // 只取 pathname 与查询参数，固定回环 base，避免协议相对路径被重解析。
    const url = requestUrl;
    if (url.pathname.startsWith("/api/")) {
      if (token !== null && !authorized(request, token)) {
        sendJson(response, 401, {
          error: { code: "unauthorized", message: "需要有效的访问令牌" },
        });
        return;
      }
      if (url.pathname === `${API_PREFIX}/logs`) {
        await routeLogsApi({ environment, url, request, response });
        return;
      }
      if (url.pathname === `${API_PREFIX}/traffic/events`) {
        routeTrafficEvents({ environment, request, response, url, state: management });
        return;
      }
      if (url.pathname === `${API_PREFIX}/metrics/events` || url.pathname === `${API_PREFIX}/accounts/events`) {
        if (url.searchParams.size > 0) throw new ApiError(400, "unsupported_parameter", "数据通知不接受查询参数");
        const path = url.pathname === `${API_PREFIX}/accounts/events` ? accountSnapshotEventsPath : metricsEventsPath;
        openQueueStream(management, response, (signal, send) => watchQueueChanges(path(resolveGatewayConfigPath(environment)), signal, send));
        return;
      }
      await routeApi(environment, url, request, response, serviceStatusCache, gatewayConfigRead, metricsExports, readMetrics, management.shutdownController.signal);
      return;
    }
    serveStatic(staticDir, url.pathname, response);
  } catch (error) {
    if (response.destroyed) return;
    if (error instanceof GatewayConfigWriteCommittedError) {
      const sendError = managementRequest ? sendManagementJson : sendJson;
      sendError(response, 500, {
        error: { code: "gateway_config_saved_cleanup_failed", message: error.message },
      });
      return;
    }
    if (error instanceof ManagementOperationError) {
      if (error.status >= 500) logger.error({ event: "management.failed", code: error.code, err: error.cause }, "WebUI 管理操作失败");
      sendManagementJson(response, error.status, {
        error: {
          code: error.code,
          ...(error.field === undefined ? {} : { field: error.field }),
          message: error.message,
        },
      });
      return;
    }
    if (error instanceof ManagementSecurityError) {
      sendManagementJson(response, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof ConfigManagementError) {
      sendManagementJson(response, error.code === "stale-revision" ? 409 : 400, {
        error: { code: error.code, field: error.field, message: error.message },
      });
      return;
    }
    if (error instanceof ApiError) {
      const sendError = managementRequest ? sendManagementJson : sendJson;
      sendError(response, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    logger.error({ event: "request.failed", err: error }, "WebUI 请求处理失败");
    const sendInternalError = managementRequest ? sendManagementJson : sendJson;
    sendInternalError(response, 500, {
      error: { code: "internal_error", message: "WebUI 内部错误" },
    });
  }
}

function createManagementState(
  environment,
  host,
  port,
  configuredOrigin,
  serviceStatusCache,
  providerStateCache,
  loadProviderState,
  loadCodexSettings,
  previewCodexSetting,
  updateCodexSetting,
  previewProviderSettings,
  applyProviderSettings,
  previewAccountSettings,
  applyAccountSettings,
  loadAccountSettings,
  refreshGatewayAccount,
  resetGatewayCredits,
) {
  const explicitConfig = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const dataDir = explicitConfig ? dirname(resolve(explicitConfig)) : userDataDir(environment);
  const originHost = host === "::1" ? "[::1]" : "127.0.0.1";
  const audit = new ManagementAuditWriter(join(dataDir, "management-audit.jsonl"));
  const tasks = new WebuiManagementTaskRunner({
    onEvent: ({ task, phase, resultCode, recovery, ...metadata }) => {
      invalidateServiceStatusSummary(serviceStatusCache);
      if (typeof metadata.sessionId !== "string") return;
      audit.record({
        ...metadata,
        target: metadata.target ?? `${task.operation}:${task.action}:${task.target ?? ""}`,
        phase,
        resultCode,
        recovery,
      });
    },
  });
  return {
    // 只有显式全网卡监听才开放令牌保护的远程管理；回环模式保持本机边界。
    remoteManagement: host === "0.0.0.0",
    configuredOrigin,
    origin: configuredOrigin ?? `http://${originHost}:${port}`,
    appServerUserAgentCache: { expiresAtMs: 0, value: null },
    snapshotReads: new Set(),
    snapshotReadsClosed: false,
    shutdownController: new AbortController(),
    serviceStatusCache,
    providerStateCache,
    loadProviderState,
    loadCodexSettings,
    previewCodexSetting,
    updateCodexSetting,
    previewProviderSettings,
    applyProviderSettings,
    previewAccountSettings,
    applyAccountSettings,
    loadAccountSettings,
    refreshGatewayAccount,
    resetGatewayCredits,
    confirmations: new ManagementConfirmationStore(),
    tasks,
    limiter: new ManagementRateLimiter(),
    audit,
  };
}

async function routeManagement(environment, url, request, response, state, token, managementLockHeld = false) {
  const loopback = isLoopbackAddress(request.socket.remoteAddress);
  if (token !== null && !authorized(request, token)) {
    throw new ApiError(401, "unauthorized", "需要有效的访问令牌");
  }
  if (!loopback && (!state.remoteManagement || token === null)) {
    throw new ApiError(503, "management_unavailable", "管理接口只允许回环访问");
  }
  const origin = request.headers.origin ?? (request.method === "GET" ? state.origin : undefined);
  const contentLength = request.headers["content-length"] === undefined
    ? undefined
    : Number(request.headers["content-length"]);
  const requestLineBytes = Buffer.byteLength(`${request.method ?? ""} ${request.url ?? ""}`);
  const headerBytes = Object.entries(request.headers)
    .reduce((total, [key, value]) => total + Buffer.byteLength(key) + Buffer.byteLength(String(value ?? "")), 0);
  // SSH 隧道用户可能使用与服务器不同的本机端口；只要 Origin 使用同协议和
  // 固定回环主机名即可归一化，不读取 Host 或转发头。
  let normalizedOrigin = normalizeLoopbackOrigin(
    origin,
    state.origin,
  );
  let expectedOrigin = state.origin;
  if (state.remoteManagement && !(loopback && normalizedOrigin === state.origin)) {
    // 此分支只能在已验证 Bearer 后使用请求 Host 作同站点约束，
    // 不能将 Host 或转发头作为匿名管理的可信来源。
    expectedOrigin = state.configuredOrigin ?? authenticatedManagementOrigin(request);
    normalizedOrigin = request.headers.origin ?? (request.method === "GET" ? expectedOrigin : undefined);
  }
  const validation = validateManagementJsonRequest({
    method: request.method,
    origin: normalizedOrigin,
    expectedOrigin: expectedOrigin ?? "http://127.0.0.1",
    contentType: request.headers["content-type"],
    contentLength,
    requestLineBytes,
    headerBytes,
    path: url.pathname.slice(`${API_PREFIX}/management`.length) || "/",
  });
  const principalId = fingerprintManagementValue(token ?? normalizedOrigin);
  const path = url.pathname.slice(`${API_PREFIX}/management`.length) || "/";
  if (!managementLockHeld
    && request.method === "POST"
    && (path === "/provider-settings" || path === "/account-settings")) {
    // 限速必须先于正文解析，避免无效或超大正文绕过写入与高风险配额。
    state.limiter.consume({ principalId, category: "write" });
    state.limiter.consume({ principalId, category: "high-risk" });
    // 完整读取并校验正文后再获取管理锁，避免慢速客户端占住 Provider
    // 管理事务；readJsonBody 会缓存结果，递归路由不会重复消费请求流。
    await readJsonBody(request, validation.maximumBodyBytes);
    return withModelProviderManagementTransaction(
      environment,
      () => routeManagement(environment, url, request, response, state, token, true),
    );
  }
  if (!managementLockHeld) {
    state.limiter.consume({ principalId, category: request.method === "POST" && path === "/accounts/refresh"
      ? "account-refresh"
      : request.method === "GET" || (request.method === "POST" && path === "/delivery/content-batch") ? "read" : "write" });
    if (request.method !== "GET" && path !== "/delivery/content-batch" && isHighRiskManagementPath(path)) {
      state.limiter.consume({ principalId, category: "high-risk" });
    }
  }
  const routeContext = {
    environment,
    maximumBodyBytes: validation.maximumBodyBytes,
    path,
    principalId,
    request,
    response,
    state,
  };
  const consumeHighRisk = () =>
    state.limiter.consume({ principalId, category: "high-risk" });
  if (await routeCodexSettingsManagement({ ...routeContext, consumeHighRisk })) return;
  if (await routeProviderManagement({
    ...routeContext,
    configPath: resolveGatewayConfigPath(environment),
    readMetrics: state.readMetrics,
  })) return;
  if (await routeTaskManagement(routeContext)) return;
  if (await routeRelayManagement({ ...routeContext, readMetrics: state.readMetrics })) return;
  if (await routeDeliveryManagement(routeContext)) return;
  if (await routeGatewaySettingsManagement({ ...routeContext, consumeHighRisk })) return;
  if (await routeStatusManagement({
    ...routeContext,
    codexCliVersion: CODEX_CLI_VERSION,
    gatewayVersion: GATEWAY_VERSION,
    readMetrics: state.readMetrics,
  })) return;
  throw new ApiError(404, "not_found", `未知管理 API：${path}`);
}

function validateAnonymousRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(403, "loopback_required", "未配置访问令牌时只允许回环访问");
  }
  // 不经 URL 归一化接受数字 IP、尾点、凭据或其他主机别名，也不信任转发头。
  const hostHeaders = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "host");
  if (hostHeaders.length !== 1 || !isLoopbackAuthority(request.headers.host)) {
    throw new ApiError(403, "host_invalid", "未配置访问令牌时 Host 必须是受支持的回环主机");
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== new URL(`http://${request.headers.host}`).origin) {
    throw new ApiError(403, "origin_invalid", "未配置访问令牌时 Origin 必须与请求 Host 的 HTTP 来源一致");
  }
}

function isLoopbackAuthority(value) {
  if (typeof value !== "string") return false;
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]+))?$/iu.exec(value);
  // SSH 本机转发端口无需与服务器监听端口一致。
  return match !== null && (match[1] === undefined || (Number(match[1]) >= 1 && Number(match[1]) <= 65_535));
}

function authenticatedManagementOrigin(request) {
  try {
    const origin = request.headers.origin;
    const source = origin === undefined ? null : new URL(origin);
    if (source !== null && (!["http:", "https:"].includes(source.protocol)
      || source.origin !== origin || source.username || source.password)) throw new Error("invalid origin");
    const host = request.headers.host;
    if (typeof host !== "string" || !host || /[\s/@\\?#,]/u.test(host)) throw new Error("invalid host");
    // HTTPS 可由反向代理终止；只使用已认证请求的 Host，不读取 Forwarded 头。
    const target = new URL(`${source?.protocol ?? "http:"}//${host}`);
    return target.origin;
  } catch {
    throw new ApiError(403, "management.origin-invalid", "管理请求来源无效");
  }
}

function normalizeLoopbackOrigin(value, expectedOrigin) {
  if (typeof value !== "string" || typeof expectedOrigin !== "string") return value;
  try {
    const candidate = new URL(value);
    const expected = new URL(expectedOrigin);
    if (candidate.origin !== value || candidate.username || candidate.password) return value;
    const loopback = candidate.hostname === "127.0.0.1"
      || candidate.hostname === "localhost"
      || candidate.hostname === "[::1]"
      || candidate.hostname === "::1";
    // SSH 本机转发端口可以与服务器监听端口不同；回环 socket 始终限制
    // 连接来源，配置 Bearer 令牌时再限制访问主体。
    const sameOrigin = candidate.protocol === expected.protocol;
    return loopback && sameOrigin ? expectedOrigin : value;
  } catch {
    return value;
  }
}
function readJsonMetadata(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

async function routeApi(environment, url, request, response, serviceStatusCache, gatewayConfigRead, metricsExports, readMetrics, shutdownSignal) {
  const path = url.pathname;
  if (!path.startsWith(`${API_PREFIX}/`)) {
    throw new ApiError(404, "not_found", `未知 API：${path}`);
  }
  const apiPath = path.slice(API_PREFIX.length);
  if (apiPath === "/time") {
    if (url.searchParams.size > 0) throw new ApiError(400, "unsupported_parameter", "服务端时间不接受查询参数");
    sendJson(response, 200, {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      nowMs: Date.now(),
    });
    return;
  }
  if (apiPath === "/providers") {
    if (url.searchParams.size > 0) throw new ApiError(400, "unsupported_parameter", "Provider 列表不接受查询参数");
    sendJson(response, 200, await readMetrics({ operation: "providers", nowMs: Date.now() }, response));
    return;
  }
  if (apiPath === "/overview") {
    await handleOverview(environment, url, response, gatewayConfigRead, readMetrics);
    return;
  }
  if (apiPath === "/daily") {
    await handleDaily(url, response, readMetrics);
    return;
  }
  if (apiPath === "/threads") {
    await handleThreads(url, response, readMetrics);
    return;
  }
  if (apiPath === "/subagents") {
    await handleSubagents(environment, url, response, readMetrics, shutdownSignal);
    return;
  }
  const subagentsMatch = apiPath.match(/^\/threads\/([^/]+)\/subagents$/u);
  if (subagentsMatch) {
    await handleSubagents(environment, url, response, readMetrics, shutdownSignal, parseThreadId(subagentsMatch[1]));
    return;
  }
  const threadMatch = apiPath.match(/^\/threads\/([^/]+)\/(run|turns)$/u);
  if (threadMatch) {
    await handleThreadDetail(
      threadMatch[1],
      threadMatch[2],
      url,
      response,
      readMetrics,
    );
    return;
  }
  if (apiPath === "/requests") {
    await handleRequests(environment, url, response, readMetrics);
    return;
  }
  if (apiPath === "/requests/export") {
    await handleRequestsExport(environment, url, request, response, metricsExports);
    return;
  }
  if (apiPath === "/errors") {
    await handleErrors(url, response, readMetrics);
    return;
  }
  if (apiPath === "/settings/summary") {
    await handleSettingsSummary(environment, response, serviceStatusCache);
    return;
  }
  if (apiPath === "/settings/traffic") {
    await handleTrafficSettings(environment, response, gatewayConfigRead);
    return;
  }
  if (apiPath === "/health") {
    sendJson(response, 200, { ok: true, service: "webui", pid: process.pid, parentPid: process.ppid });
    return;
  }
  if (apiPath === "/accounts") {
    await sendAccountSnapshots(environment, response, readMetrics);
    return;
  }
  if (await routeTrafficApi({ apiPath, environment, request, response, url, signal: shutdownSignal })) return;
  throw new ApiError(404, "not_found", `未知 API：${apiPath}`);
}
async function readMetricsForResponse(owner, environment, task, response, shutdownSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once("close", abort);
  shutdownSignal.addEventListener("abort", abort, { once: true });
  if (response.destroyed || shutdownSignal.aborted) abort();
  try {
    return await owner.read(environment, task, { signal: controller.signal });
  } catch (error) {
    if (error instanceof MetricsReadError) {
      if (error.code !== "metrics_read_cancelled") logger.warn({ event: "metrics.read-failed", operation: task.operation,
        code: error.code, phase: error.phase, reasonCode: error.reasonCode,
      }, "指标读取未完成");
      throw new ApiError(error.code === "metrics_read_busy" ? 429 : 503, error.code, error.message);
    }
    throw error;
  } finally {
    response.off("close", abort);
    shutdownSignal.removeEventListener("abort", abort);
  }
}

function resolveGatewayConfigPath(environment) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  return explicitConfigFile
    ? resolve(explicitConfigFile)
    : join(userDataDir(environment), "config.toml");
}

async function handleOverview(environment, url, response, configRead, readMetrics) {
  for (const key of url.searchParams.keys()) {
    if (!["range", "from", "to"].includes(key)) throw new ApiError(400, "unsupported_parameter", "控制台仅接受时间范围查询参数");
    if (url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "invalid_parameter", "时间范围查询参数不能重复");
  }
  const nowMs = Date.now();
  const range = parseRange(url, "90d", nowMs);
  const document = await readAvailableGatewayConfig(environment, response, configRead);
  if (document === null) return;
  const modelAliases = document.display.model_aliases ?? {};
  const heatmapStart = new Date(nowMs);
  heatmapStart.setHours(0, 0, 0, 0);
  heatmapStart.setDate(heatmapStart.getDate() - 89);
  const heatmapRange = { name: "90d", startAtMs: heatmapStart.getTime(), endAtMs: nowMs };
  sendJson(response, 200, await readMetrics({ operation: "overview", nowMs, range, modelAliases, heatmapRange }, response));
}

async function handleDaily(url, response, readMetrics) {
  const range = parseRange(url);
  const daily = await readMetrics({ operation: "daily", nowMs: range.endAtMs, range }, response);
  sendJson(response, 200, { range, generatedAt: new Date(range.endAtMs).toISOString(), daily });
}

async function handleThreads(url, response, readMetrics) {
  const range = parseRange(url, "all");
  const query = parseThreadQuery(url);
  const { matchedTotal, ...page } = await readMetrics({ operation: "threads", nowMs: range.endAtMs, range, query }, response);
  sendJson(response, 200, {
    generatedAt: new Date().toISOString(), range, ...page, total: matchedTotal,
  });
}

async function handleSubagents(environment, url, response, readMetrics, shutdownSignal, threadId) {
  const allowed = ["offset", "limit", "sortKey", "sortDirection", ...(threadId === undefined ? [] : ["parentTurnId"])];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key)) throw new ApiError(400, "unsupported_parameter", `子代理列表只接受 ${allowed.join("、")}`);
    if (url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "invalid_parameter", "子代理查询参数不能重复");
  }
  const parentTurnId = url.searchParams.get("parentTurnId");
  if (parentTurnId !== null && (!parentTurnId.trim() || parentTurnId.length > 128)) {
    throw new ApiError(400, "invalid_parent_turn_id", "parentTurnId 必须为 1–128 个字符");
  }
  const sortKey = url.searchParams.get("sortKey") ?? "last";
  const sortDirection = url.searchParams.get("sortDirection") ?? "desc";
  if (!["time", "last"].includes(sortKey)) throw new ApiError(400, "invalid_sort", "子代理列表只支持 time 或 last 排序");
  if (!["asc", "desc"].includes(sortDirection)) throw new ApiError(400, "invalid_direction", "sortDirection 只支持 asc 或 desc");
  const query = {
    ...(parentTurnId === null ? {} : { parentTurnId }),
    offset: parseBoundedInt(url.searchParams.get("offset"), "offset", 0, null, 0),
    limit: parseBoundedInt(url.searchParams.get("limit"), "limit", 1, 100, 20),
    sortKey,
    sortDirection,
  };
  const page = await readMetrics({ operation: "subagents", nowMs: Date.now(), ...(threadId === undefined ? {} : { threadId }), query }, response);
  // Release the SQLite snapshot before querying the Gateway's existing connections.
  const controller = new AbortController();
  const disconnected = () => controller.abort();
  response.once("close", disconnected);
  shutdownSignal.addEventListener("abort", disconnected, { once: true });
  if (shutdownSignal.aborted) disconnected();
  try {
    if (response.destroyed) return;
    const states = page.subagents.length === 0 ? [] : await requestGatewayThreadStates(
      resolveGatewayConfigPath(environment), page.subagents.map(agent => agent.threadId), controller.signal,
    );
    const byThread = new Map(states.map(state => [state.threadId, state]));
    if (response.destroyed) return;
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(), ...(threadId === undefined ? {} : { threadId }), ...page,
      subagents: page.subagents.map(agent => ({
        ...agent,
        liveState: byThread.get(agent.threadId) ?? { threadId: agent.threadId, status: "unknown", reason: "invalid_response" },
      })),
    });
  } finally {
    response.off("close", disconnected);
    shutdownSignal.removeEventListener("abort", disconnected);
  }
}

async function handleThreadDetail(rawThreadId, view, url, response, readMetrics) {
  const threadId = parseThreadId(rawThreadId);
  if (view === "run" && url.searchParams.size > 0) throw new ApiError(400, "unsupported_parameter", "run 返回全部历史累计；期间查询请使用 turns");
  const range = parseRange(url, "all");
  const query = view === "run" ? null : parseThreadQuery(url, threadId);
  if (view === "run") {
    const { summary, subagent } = await readMetrics({ operation: "run", nowMs: Date.now(), threadId }, response);
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      threadId,
      agentPath: subagent.agentPath,
      parentThreadId: subagent.parentThreadId,
      parentTurnId: subagent.parentTurnId,
      latestTurn: summary.latestTurn,
      sessionDurationMs: summary.sessionDurationMs,
      sessionTiming: summary.sessionTiming,
      latestExecution: summary.latestExecution,
      threadAggregate: summary.threadAggregate,
    });
    return;
  }
  const { matchedTotal, ...page } = await readMetrics({ operation: "turns", nowMs: Date.now(), threadId, range, query }, response);
  sendJson(response, 200, {
    generatedAt: new Date().toISOString(), threadId, range, ...page, total: matchedTotal,
  });
}

async function handleRequests(environment, url, response, readMetrics) {
  if (url.searchParams.has("afterId")) {
    throw new ApiError(
      400,
      "unsupported_parameter",
      "afterId 不受支持，请使用 offset",
    );
  }
  const range = parseRange(url);
  const offset = parseBoundedInt(url.searchParams.get("offset"), "offset", 0, null, 0);
  const sort = parseRequestSort(url);
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    "limit",
    1,
    500,
    100,
  );
  const filters = parseMetricsFilters(url);
  const page = await readMetrics({ operation: "requests", nowMs: range.endAtMs, range, query: {
    offset, limit, sortKey: sort.key, sortDirection: sort.direction, ...filters,
  } }, response);
  const records = page.records;
  if (records.some(record => record.source === "relay")) {
    const config = readGatewayConfig(resolveGatewayConfigPath(environment));
    const relay = modelRelayConfigSchema.parse(config.model_relay ?? {});
    const callers = new Map(relay.callers.map(caller => [caller.caller_id, caller]));
    for (const record of records) {
      const caller = callers.get(record.callerId);
      if (record.source === "relay" && caller?.key_id === record.keyId && caller.display_name) {
        record.callerDisplayName = caller.display_name;
      }
    }
  }
  sendJson(response, 200, {
    range, generatedAt: new Date(range.endAtMs).toISOString(), records,
    nextOffset: page.nextOffset, total: page.matchedTotal, aggregate: page.aggregate,
  });
}

async function handleRequestsExport(environment, url, request, response, exports) {
  const range = parseRange(url);
  const filters = parseMetricsFilters(url);
  const sort = parseRequestSort(url);
  const controller = new AbortController();
  const framed = request.headers.accept === "application/vnd.codexc.metrics-export.v1";
  // The browser explicitly opts in; ordinary HTTP and CLI exports retain JSON.
  // Each frame has a one-byte kind and four-byte big-endian payload length.
  const frame = (kind, payload = Buffer.alloc(0)) => {
    const header = Buffer.alloc(5);
    header[0] = kind;
    header.writeUInt32BE(payload.length, 1);
    return Buffer.concat([header, payload]);
  };
  const output = framed ? new Writable({
    write(chunk, _encoding, callback) {
      response.write(frame(1, chunk), callback);
    },
  }) : response;
  const outputError = error => output.destroy(error);
  if (framed) response.on("error", outputError);
  const disconnected = () => controller.abort();
  response.once("close", disconnected);
  try {
    response.setHeader("Content-Type", framed ? "application/vnd.codexc.metrics-export.v1" : "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    await exports.stream(environment, {
      ...filters, resolvedRange: range, sortKey: sort.key, sortDirection: sort.direction, webui: true,
    }, { output, signal: controller.signal });
    if (!response.destroyed) response.end(framed ? frame(2) : undefined);
  } catch (error) {
    if (response.headersSent || response.destroyed) {
      if (error instanceof MetricsExportError && error.code !== "metrics_export_cancelled") {
        logger.warn({ event: "metrics.export-interrupted", code: error.code }, "指标导出流未完成");
      }
      if (framed && !response.destroyed && error instanceof MetricsExportError) {
        response.end(frame(3, Buffer.from(error.code, "utf8")));
        return;
      }
      response.destroy();
      return;
    }
    if (error instanceof MetricsExportError) {
      throw new ApiError(error.code === "metrics_export_busy" ? 429 : 503, error.code, error.message);
    }
    throw error;
  } finally {
    response.off("close", disconnected);
    if (framed) {
      response.off("error", outputError);
      output.destroy();
    }
  }
}

async function handleErrors(url, response, readMetrics) {
  const range = parseRange(url);
  const filters = parseMetricsFilters(url);
  const sort = parseRequestSort(url);
  const offset = parseBoundedInt(url.searchParams.get("offset"), "offset", 0, null, 0);
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    "limit",
    1,
    500,
    100,
  );
  const { page, errors } = await readMetrics({ operation: "errors", nowMs: range.endAtMs, range, query: {
    ...filters, offset, limit, sortKey: sort.key, sortDirection: sort.direction,
  } }, response);
  sendJson(response, 200, {
    range, generatedAt: new Date(range.endAtMs).toISOString(), errors, records: page.records,
    nextOffset: page.nextOffset, total: page.matchedTotal, aggregate: page.aggregate,
  });
}

function loadAvailableGatewaySettings(environment) {
  const { configPath } = resolveWebuiSettings({ environment });
  if (!existsSync(configPath)) {
    throw new ApiError(503, "configuration_unavailable", "Gateway 尚未初始化，请先运行 codexc init");
  }
  return loadGatewaySettings(environment);
}

async function handleTrafficSettings(environment, response, state) {
  const document = await readAvailableGatewayConfig(environment, response, state);
  if (document !== null) sendJson(response, 200, { modelTrafficDumpEnabled: document.debug?.model_traffic_dump === true });
}

async function readAvailableGatewayConfig(environment, response, state) {
  const configPath = resolveGatewayConfigPath(environment);
  if (!existsSync(configPath)) {
    throw new ApiError(503, "configuration_unavailable", "Gateway 尚未初始化，请先运行 codexc init");
  }
  state.responses.add(response);
  const disconnected = () => {
    state.responses.delete(response);
    if (state.responses.size === 0) state.controller?.abort();
  };
  response.once("close", disconnected);
  try {
    // Let an abandoned read release its resources before starting another one.
    while (state.pending !== null && state.controller?.signal.aborted) {
      await state.pending.catch(() => {});
    }
    if (response.destroyed) return null;
    // Share only a current read, never a cached value or permission decision.
    if (state.pending === null) {
      state.controller = new AbortController();
      state.pending = readPrivateConfigFile(configPath, { signal: state.controller.signal })
        .then(content => validateGatewayConfigStructureDocument(parseGatewayConfig(content)))
        .finally(() => { state.pending = null; state.controller = null; });
    }
    const document = await state.pending;
    return response.destroyed ? null : document;
  } catch {
    if (!response.destroyed) {
      throw new ApiError(503, "configuration_unavailable", "Gateway 配置不可用，请检查配置格式和私有文件权限");
    }
    return null;
  } finally {
    response.off("close", disconnected);
    state.responses.delete(response);
  }
}

async function handleSettingsSummary(environment, response, serviceStatusCache) {
  const gateway = loadAvailableGatewaySettings(environment);
  const serviceResults = await loadServiceStatusSummary(environment, serviceStatusCache);
  const platform = serviceResults.find((result) => result.platform !== null)?.platform ?? null;
  const entries = serviceResults.map((result) => result.entry);
  const services = {
    available: platform !== null,
    platform,
    healthy: serviceSummaryHealthy(entries, platform, environment),
    entries,
  };
  sendJson(response, 200, {
    observedAt: new Date().toISOString(),
    revision: gateway.revision,
    gateway: {
      display: gateway.display,
      system: {
        approvalTimeoutSeconds: gateway.system.approvalTimeoutSeconds,
        defaultWorkspace: gateway.system.defaultWorkspace,
        defaultModel: gateway.system.defaultModel,
        modelTrafficMode: gateway.system.modelTrafficMode,
        modelTrafficInputItems: gateway.system.modelTrafficInputItems,
        modelTrafficItemMaxBytes: gateway.system.modelTrafficItemMaxBytes,
        modelTrafficDumpEnabled: gateway.system.modelTrafficDumpEnabled,
        modelTrafficRetentionDays: gateway.system.modelTrafficRetentionDays,
      },
      automation: {
        scheduledTasksEnabled: gateway.automation.scheduledTasksEnabled,
      },
      network: {
        configuredFields: Object.entries(gateway.network)
          .filter(([, value]) => value.configured).map(([field]) => field),
      },
      advanced: gateway.advanced,
      webui: gateway.webui,
      metrics: {
        storage: gateway.metrics.storage,
      },
      channels: gateway.channels,
    },
    services,
    cli: [
      { id: "gateway-config", label: "日常设置", command: "codexc config", detail: "进入 Codex 新会话偏好、Gateway、显示和 WebUI 设置" },
      { id: "codex-setup", label: "Provider 接入", command: "codexc setup", detail: "进入 Provider 与模型接入设置" },
      { id: "channels", label: "通讯渠道", command: "codexc setup", detail: "菜单路径：通讯渠道" },
      { id: "metrics-storage", label: "指标存储", command: "codexc config", detail: "菜单路径：指标存储" },
      { id: "service-status", label: "查看全部后台服务状态", command: "codexc status all", detail: "查看 App Server、Gateway、已安装 Relay 与 WebUI 状态" },
      { id: "service-webui", label: "查看 WebUI 状态", command: "codexc status webui", detail: "查看 WebUI 服务状态" },
      { id: "service-restart", label: "重启全部后台服务", command: "codexc restart all", detail: "重启 Gateway、App Server、未关闭的 WebUI 和已启用 Relay" },
    ],
  });
}

function parseRange(url, defaultRange = "90d", nowMs = Date.now()) {
  const options = Object.fromEntries(["range", "from", "to"].filter((key) => url.searchParams.has(key)).map((key) => [key, url.searchParams.get(key)]));
  try {
    return metricsRangeOptions(options, nowMs, defaultRange);
  } catch {
    throw new ApiError(400, "invalid_range", "时间范围无效；请选择预设范围，或同时指定 from/to（YYYY-MM-DD，包含结束日），不能混用");
  }
}

function parseMetricsFilters(url, threadId) {
  const allowed = new Set(["range", "from", "to", "source", "callerId", "threadId", "turnId", "provider", "model", "operation", "requestPurpose", "status", "filter", "offset", "limit", "sort", "direction"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new ApiError(400, "unsupported_parameter", "包含不支持的指标查询参数");
    if (key !== "provider" && url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "invalid_parameter", "除 provider 外的指标查询参数不能重复");
  }
  const values = Object.fromEntries(["source", "callerId", "threadId", "turnId", "provider", "model", "operation", "requestPurpose", "status"].filter((key) => url.searchParams.has(key)).map((key) => [key, url.searchParams.get(key)]));
  if (url.searchParams.has("provider")) values.provider = url.searchParams.getAll("provider");
  if (threadId !== undefined) {
    if (values.threadId !== undefined && values.threadId !== threadId) throw new ApiError(400, "invalid_filter", "Thread ID 与路径不一致");
    values.threadId = threadId;
  }
  const filter = parseRequestFilter(url);
  try {
    return parseRequestMetricsFilters({ ...values, ...(filter ? { filter } : {}) });
  } catch (error) {
    throw new ApiError(400, "invalid_filter", error.message);
  }
}

function parseThreadQuery(url, threadId) {
  if (url.searchParams.has("requestPurpose")) {
    throw new ApiError(400, "unsupported_parameter", "任务统计固定排除自动审查，请在请求页按用途筛选");
  }
  const sortKey = url.searchParams.get("sort") ?? "last";
  const sortDirection = url.searchParams.get("direction") ?? "desc";
  const sortKeys = threadId === undefined
    ? ["time", "last", "thread", "provider", "model", "turns", "requests", "input", "output", "totalTokens", "compact"]
    : ["time", "last", "turn", "provider", "model", "requests", "failures", "input", "output", "compact"];
  if (!sortKeys.includes(sortKey)) throw new ApiError(400, "invalid_sort", "不支持该会话排序字段");
  if (!["asc", "desc"].includes(sortDirection)) throw new ApiError(400, "invalid_direction", "direction 只支持 asc 或 desc");
  return {
    ...parseMetricsFilters(url, threadId),
    offset: parseBoundedInt(url.searchParams.get("offset"), "offset", 0, null, 0),
    limit: parseBoundedInt(url.searchParams.get("limit"), "limit", 1, 500, 100),
    sortKey,
    sortDirection,
  };
}

function parseRequestSort(url) {
  const sort = url.searchParams.get("sort") ?? "time";
  const direction = url.searchParams.get("direction") ?? "desc";
  const key = Object.hasOwn(requestSortKeys, sort) ? requestSortKeys[sort] : undefined;
  if (key === undefined) {
    throw new ApiError(400, "invalid_sort", "sort 不支持该请求字段");
  }
  if (direction !== "asc" && direction !== "desc") {
    throw new ApiError(400, "invalid_direction", "direction 只支持 asc 或 desc");
  }
  return { key, direction };
}

function parseRequestFilter(url) {
  const raw = url.searchParams.get("filter");
  if (raw === null) return "";
  const value = raw.trim();
  if (value.length > 128) {
    throw new ApiError(400, "invalid_filter", "filter 最多 128 个字符");
  }
  return value;
}

function parseBoundedInt(rawValue, name, minimum, maximum, fallback) {
  if (rawValue === null) return fallback;
  if (!/^[0-9]+$/u.test(rawValue)) {
    throw new ApiError(400, `invalid_${name}`, `${name} 必须是整数`);
  }
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || (maximum !== null && value > maximum)
  ) {
    throw new ApiError(
      400,
      `invalid_${name}`,
      `${name} 必须在 ${minimum}${maximum === null ? "" : ` 到 ${maximum}`} 之间`,
    );
  }
  return value;
}

function parseThreadId(rawThreadId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(rawThreadId)) {
    throw new ApiError(400, "invalid_thread_id", "Thread ID 无效");
  }
  return rawThreadId;
}

function serveStatic(staticDir, pathname, response) {
  const relative = pathname === "/" ? "/index.html" : pathname;
  const resolved = resolve(staticDir, `.${relative}`);
  if (resolved !== staticDir && !resolved.startsWith(`${staticDir}${sep}`)) {
    throw new ApiError(404, "not_found", "路径无效");
  }
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) throw new Error("not a file");
    const type = contentTypes[extname(resolved)] ?? "application/octet-stream";
    response.writeHead(200, {
      ...(type.startsWith("text/html") ? WEBUI_DOCUMENT_SECURITY_HEADERS : {}),
      "content-type": type,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    });
    response.end(readFileSync(resolved));
  } catch {
    if (pathname === "/") {
      response.writeHead(200, {
        ...WEBUI_DOCUMENT_SECURITY_HEADERS,
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      response.end(
        "<!doctype html><meta charset=\"utf-8\"><title>Codex WebUI</title>"
        + "<p>WebUI 前端尚未构建。请先运行 <code>npm run build</code>（webui 目录），"
        + `或直接使用 <a href="${API_PREFIX}/overview">${API_PREFIX}/overview</a> 等只读 JSON 接口。</p>`,
      );
      return;
    }
    throw new ApiError(404, "not_found", `静态文件不存在：${pathname}`);
  }
}

function main() {
  try {
    const settings = resolveWebuiSettings({ args: process.argv.slice(2) });
    applyConfiguredTimezone(process.env, settings.configPath);
    const { host, server, closeNotifications, waitForNotificationsExit } = createWebuiServer({
      environment: process.env,
      host: settings.host,
      port: settings.port,
      token: settings.token,
    });
    // Browsers may open TCP preconnections without sending any HTTP request.
    // Node's HTTP idle-connection cleanup does not reap those sockets.
    const pendingConnections = new Set();
    server.on("connection", socket => {
      pendingConnections.add(socket);
      socket.once("close", () => pendingConnections.delete(socket));
    });
    server.on("request", (request, response) => {
      pendingConnections.delete(request.socket);
      response.once("finish", () => {
        if (shuttingDown) server.closeIdleConnections();
      });
    });
    server.on("error", (error) => {
      writeCliMessage(
        "failure",
        `WebUI 启动失败：${error instanceof Error ? error.message : String(error)}`,
      );
      shutdown(1);
    });
    server.listen(settings.port, host, () => {
      if (!process.stdout.isTTY) {
        logger.info({ event: "service.started", host, port: settings.port }, "WebUI 已启动");
        return;
      }
      const configNote = existsSync(settings.configPath)
        ? `（配置 [webui]：${settings.configPath}，CLI 参数优先）`
        : "";
      if (host === "0.0.0.0") {
        console.log(`Codex WebUI 已监听 0.0.0.0:${settings.port}（访问令牌保护）${configNote}`);
        console.log(`请通过服务器实际 IP 访问 http://<服务器IP>:${settings.port}/`);
        console.log("API 请求需要请求头 Authorization: Bearer <令牌>，或使用 ?token=<令牌> 打开。");
      } else {
        console.log(`Codex WebUI: http://${host.includes(":") ? `[${host}]` : host}:${settings.port}/${configNote}`);
      }
      console.log("按 Ctrl+C 停止。");
    });
    let shuttingDown = false;
    const shutdown = (exitCode = 0) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const deadline = setTimeout(() => {
        logger.error({ event: "service.shutdown-timeout", timeoutMs: serviceShutdownTimeoutMs }, "WebUI 请求未在停止期限内结束，关闭剩余连接");
        server.closeAllConnections();
        process.exitCode = 1;
      }, serviceShutdownTimeoutMs);
      deadline.unref();
      const resourcesClosed = closeNotifications().catch(async () => {
        logger.error({ event: "service.background-close-failed" }, "WebUI 后台资源未确认退出，保留所有权等待实际结束");
        process.exitCode = 1;
        await waitForNotificationsExit();
      });
      const httpClosed = new Promise(resolve => server.close(resolve));
      void Promise.all([httpClosed, resourcesClosed]).then(() => {
        clearTimeout(deadline);
        process.exit(process.exitCode || exitCode);
      });
      for (const socket of pendingConnections) socket.destroy();
      server.closeIdleConnections();
    };
    process.on("SIGINT", () => shutdown());
    process.on("SIGTERM", () => shutdown());
    installServiceControlHandler(message => {
      if (message?.type === "codexc-stop") shutdown();
    });
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * WebUI 服务进程时区跟随 `[codex].timezone`：`/api/v1/time` 返回该值，页面时间展示与按天、
 * 按小时的指标分组都按它计算。`TZ` 只在进程启动时生效，未配置时保持继承的系统时区，
 * 因此改动后需要重启 WebUI 服务。
 */
export function applyConfiguredTimezone(environment, configPath) {
  if (!existsSync(configPath)) return;
  const timezone = loadGatewaySettings(environment).system.appServerTimezone;
  if (timezone !== null) environment.TZ = timezone;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
