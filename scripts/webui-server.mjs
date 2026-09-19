import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectMetricsDatabase,
  metricsDatabaseCanUpgrade,
  readWeeklyQuota,
} from "./metrics-database-access.mjs";
import { metricsRangeOptions } from "./metrics-command-options.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { userDataDir } from "./runtime-config.mjs";
import {
  assertWebuiHost,
  parseWebuiCliArgs,
} from "./webui-command-options.mjs";
import {
  readGatewayConfig,
  validateWebuiConfigDocument,
} from "../runtime/gateway-config.mjs";
import { requestGatewayAccountRefresh } from "../runtime/gateway-account-refresh.mjs";
import {
  RequestMetricsQueryService,
  parseRequestMetricsFilters,
  SqliteModelRequestMetricsStore,
} from "../dist/observability/index.js";
import {
  ConfigManagementError,
  loadGatewaySettings,
} from "./config-management.mjs";
import { loadModelProviderManagementState } from "./model-provider-management.mjs";
import { loadServiceStatusSummary } from "./webui-service-status.mjs";
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
} from "./webui-management-operations.mjs";
import { routeTrafficApi } from "./webui-traffic-route.mjs";
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
import { routeGatewaySettingsManagement } from "./webui-management-gateway-route.mjs";
import {
  routeProviderManagement,
  sendAccountSnapshots,
} from "./webui-management-provider-route.mjs";
import { routeStatusManagement } from "./webui-management-status-route.mjs";
import { routeTaskManagement } from "./webui-management-task-route.mjs";

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
  tokensPerSecond: "tokensPerSecond",
};
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_VERSION = readJsonMetadata(join(PACKAGE_DIR, "package.json"))?.version ?? null;
const SOURCE_GATEWAY_VERSION = readJsonMetadata(join(PACKAGE_DIR, "src", "version.json"))?.version ?? null;
const GATEWAY_VERSION = PACKAGE_VERSION ?? SOURCE_GATEWAY_VERSION;
const CODEX_CLI_VERSION = (readJsonMetadata(join(PACKAGE_DIR, "src", "codex-protocol", "version.json"))?.codexCli ?? null)
  ?.replace(/^codex-cli\s+/u, "") ?? null;
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
  loadProviderState = loadModelProviderManagementState,
  loadCodexSettings = loadCodexUserSettings,
  previewCodexSetting = previewCodexUserSetting,
  updateCodexSetting = updateCodexUserSetting,
  previewProviderSettings = previewProviderSettingsMutation,
  applyProviderSettings = applyProviderSettingsMutation,
  previewAccountSettings = previewAccountSettingsMutation,
  applyAccountSettings = applyAccountSettingsMutation,
  loadAccountSettings = loadAccountSettingsResource,
  refreshGatewayAccount = requestGatewayAccountRefresh,
} = {}) {
  assertWebuiHost(host);
  if (host === "0.0.0.0" && token === null) {
    throw new Error(
      "WebUI 绑定非回环地址时必须提供访问令牌（请通过 codexc config 或配置 [webui] token 设置）",
    );
  }
  const serviceStatusCache = { expiresAtMs: 0, value: null, pending: null };
  const providerStateCache = { expiresAtMs: 0, value: null, pending: null };
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
  );
  const server = createServer((request, response) => {
    handleRequest(environment, staticDir, host, token, serviceStatusCache, management, request, response);
  });
  return { host, server, staticDir, token };
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

async function handleRequest(environment, staticDir, host, token, serviceStatusCache, management, request, response) {
  let managementRequest = false;
  try {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const managementPrefix = `${API_PREFIX}/management`;
    managementRequest = requestUrl.pathname === managementPrefix || requestUrl.pathname.startsWith(`${managementPrefix}/`);
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
      await routeApi(environment, url, request, response, serviceStatusCache);
      return;
    }
    serveStatic(staticDir, url.pathname, response);
  } catch (error) {
    if (error instanceof ManagementOperationError) {
      sendManagementJson(response, error.code === "stale-revision" ? 409 : 400, {
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
    console.error(error);
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
) {
  const explicitConfig = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const dataDir = explicitConfig ? dirname(resolve(explicitConfig)) : userDataDir(environment);
  const originHost = host === "::1" ? "[::1]" : "127.0.0.1";
  const audit = new ManagementAuditWriter(join(dataDir, "management-audit.jsonl"));
  const tasks = new WebuiManagementTaskRunner({
    onEvent: ({ task, phase, resultCode, recovery, ...metadata }) => {
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
    // 管理请求始终只接受回环连接；即使 WebUI 绑定 0.0.0.0，也允许通过 SSH
    // 隧道访问 127.0.0.1，再由下面的 socket 检查拒绝公网直连管理接口。
    origin: configuredOrigin ?? `http://${originHost}:${port}`,
    appServerUserAgentCache: { expiresAtMs: 0, value: null },
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
    confirmations: new ManagementConfirmationStore(),
    tasks,
    limiter: new ManagementRateLimiter(),
    audit,
  };
}

async function routeManagement(environment, url, request, response, state, token, managementLockHeld = false) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
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
  const normalizedOrigin = normalizeLoopbackOrigin(
    origin,
    state.origin,
  );
  const validation = validateManagementJsonRequest({
    method: request.method,
    origin: normalizedOrigin,
    expectedOrigin: state.origin ?? "http://127.0.0.1",
    contentType: request.headers["content-type"],
    contentLength,
    requestLineBytes,
    headerBytes,
  });
  if (token !== null && !authorized(request, token)) {
    throw new ApiError(401, "unauthorized", "需要有效的访问令牌");
  }
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
    state.limiter.consume({ principalId, category: request.method === "GET" ? "read" : "write" });
    if (request.method !== "GET" && isHighRiskManagementPath(path)) {
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
    openMetricsStore,
  })) return;
  if (await routeTaskManagement({
    ...routeContext,
    gatewayVersion: SOURCE_GATEWAY_VERSION ?? PACKAGE_VERSION ?? null,
  })) return;
  if (await routeGatewaySettingsManagement({ ...routeContext, consumeHighRisk })) return;
  if (await routeStatusManagement({
    ...routeContext,
    codexCliVersion: CODEX_CLI_VERSION,
    gatewayVersion: GATEWAY_VERSION,
    openMetricsStore,
  })) return;
  throw new ApiError(404, "not_found", `未知管理 API：${path}`);
}

function normalizeLoopbackOrigin(value, expectedOrigin) {
  if (typeof value !== "string" || typeof expectedOrigin !== "string") return value;
  try {
    const candidate = new URL(value);
    const expected = new URL(expectedOrigin);
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

async function routeApi(environment, url, request, response, serviceStatusCache) {
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
    const store = openMetricsStore(environment, Date.now());
    try {
      sendJson(response, 200, { providers: store.providers() });
    } finally {
      store.close();
    }
    return;
  }
  if (apiPath === "/overview") {
    handleOverview(environment, url, response);
    return;
  }
  if (apiPath === "/daily") {
    handleDaily(environment, url, response);
    return;
  }
  if (apiPath === "/threads") {
    handleThreads(environment, url, response);
    return;
  }
  const threadMatch = apiPath.match(/^\/threads\/([^/]+)\/(run|turns)$/u);
  if (threadMatch) {
    handleThreadDetail(
      environment,
      threadMatch[1],
      threadMatch[2],
      url,
      response,
    );
    return;
  }
  if (apiPath === "/requests") {
    handleRequests(environment, url, response);
    return;
  }
  if (apiPath === "/requests/export") {
    handleRequestsExport(environment, url, response);
    return;
  }
  if (apiPath === "/errors") {
    handleErrors(environment, url, response);
    return;
  }
  if (apiPath === "/settings/summary") {
    await handleSettingsSummary(environment, response, serviceStatusCache);
    return;
  }
  if (apiPath === "/health") {
    sendJson(response, 200, { ok: true, service: "webui" });
    return;
  }
  if (apiPath === "/accounts") {
    sendAccountSnapshots(environment, response, openMetricsStore);
    return;
  }
  if (await routeTrafficApi({ apiPath, environment, request, response, url })) return;
  throw new ApiError(404, "not_found", `未知 API：${apiPath}`);
}
function openMetricsStore(environment, endAtMs = Date.now()) {
  const status = inspectMetricsDatabase(environment);
  if (!status.exists) {
    throw new ApiError(
      503,
      "metrics_database_unavailable",
      "指标数据库尚未创建，请先运行 Gateway 收集模型请求",
    );
  }
  if (!status.compatible) {
    throw new ApiError(
      503,
      "metrics_database_incompatible",
      metricsDatabaseCanUpgrade(status.schemaVersion)
        ? "指标数据库版本不兼容，请运行 codexc update"
        : "指标数据库版本不兼容，请停止 Gateway 后运行 codexc metrics reset",
    );
  }
  return new SqliteModelRequestMetricsStore(status.databasePath, endAtMs, {
    readOnly: true,
  });
}

function resolveGatewayConfigPath(environment) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  return explicitConfigFile
    ? resolve(explicitConfigFile)
    : join(userDataDir(environment), "config.toml");
}

function handleOverview(environment, url, response) {
  const nowMs = Date.now();
  const range = parseRange(url, "90d", nowMs);
  const heatmapStart = new Date(nowMs);
  heatmapStart.setHours(0, 0, 0, 0);
  heatmapStart.setDate(heatmapStart.getDate() - 89);
  const heatmapRange = { name: "90d", startAtMs: heatmapStart.getTime(), endAtMs: nowMs };
  const generatedAt = new Date(nowMs).toISOString();
  const store = openMetricsStore(environment, nowMs);
  try {
    const snapshot = store.readSnapshot(() => {
      const service = new RequestMetricsQueryService(store);
      const overview = service.overview(range);
      return {
        range, generatedAt,
        global: overview.global,
        threadCount: overview.threadCount,
        turnCount: overview.turnCount,
        providers: overview.providers,
        errors: overview.errors,
        weeklyQuota: toWebuiWeeklyQuota(readWeeklyQuota(store, nowMs)),
        trend: { range, generatedAt, ...service.trend(range) },
        heatmap: { range: heatmapRange, generatedAt, daily: service.daily(heatmapRange) },
      };
    });
    sendJson(response, 200, snapshot);
  } finally {
    store.close();
  }
}

function handleDaily(environment, url, response) {
  const range = parseRange(url);
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const daily = new RequestMetricsQueryService(store).daily(range);
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      daily,
    });
  } finally {
    store.close();
  }
}

function handleThreads(environment, url, response) {
  const range = parseRange(url, "all");
  const query = parseThreadQuery(url);
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const { matchedTotal, ...page } = new RequestMetricsQueryService(store).threadList(range, query);
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      range,
      ...page,
      total: matchedTotal,
    });
  } finally {
    store.close();
  }
}

function handleThreadDetail(environment, rawThreadId, view, url, response) {
  const threadId = parseThreadId(rawThreadId);
  if (view === "run" && url.searchParams.size > 0) throw new ApiError(400, "unsupported_parameter", "run 返回全部历史累计；期间查询请使用 turns");
  const range = parseRange(url, "all");
  const query = view === "run" ? null : parseThreadQuery(url, threadId);
  const store = openMetricsStore(environment);
  try {
    const queries = new RequestMetricsQueryService(store);
    if (view === "run") {
      const summary = queries.threadSummary(threadId);
      const subagent = queries.subagentThread(threadId);
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        threadId,
        agentPath: subagent.agentPath,
        parentThreadId: subagent.parentThreadId,
        parentTurnId: subagent.parentTurnId,
        latestTurn: summary.latestTurn,
        threadAggregate: summary.threadAggregate,
      });
      return;
    }
    const { matchedTotal, ...page } = queries.threadTurnSummaries(threadId, range, query);
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      threadId,
      range,
      ...page,
      total: matchedTotal,
    });
  } finally {
    store.close();
  }
}

function handleRequests(environment, url, response) {
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
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const page = new RequestMetricsQueryService(store).page(range, {
      offset,
      limit,
      sortKey: sort.key,
      sortDirection: sort.direction,
      ...filters,
    });
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      records: page.records,
      nextOffset: page.nextOffset,
      total: page.matchedTotal,
      aggregate: page.aggregate,
    });
  } finally {
    store.close();
  }
}

function handleRequestsExport(environment, url, response) {
  const range = parseRange(url);
  const filters = parseMetricsFilters(url);
  const sort = parseRequestSort(url);
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const queries = new RequestMetricsQueryService(store);
    const records = [];
    let offset = 0;
    do {
      const page = queries.page(range, { ...filters, sortKey: sort.key, sortDirection: sort.direction, offset, limit: 500 });
      records.push(...page.records);
      offset = page.nextOffset ?? -1;
    } while (offset >= 0);
    sendJson(response, 200, {
      range, filters, generatedAt: new Date(range.endAtMs).toISOString(),
      records, total: records.length,
      aggregate: queries.aggregate("global", range, filters).aggregate,
    });
  } finally {
    store.close();
  }
}

function handleErrors(environment, url, response) {
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
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const queries = new RequestMetricsQueryService(store);
    const page = queries.page(range, {
      ...filters,
      offset,
      limit,
      sortKey: sort.key,
      sortDirection: sort.direction,
      onlyFailures: true,
    });
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      errors: queries.errors(range, filters),
      records: page.records,
      nextOffset: page.nextOffset,
      total: page.matchedTotal,
      aggregate: page.aggregate,
    });
  } finally {
    store.close();
  }
}

async function handleSettingsSummary(environment, response, serviceStatusCache) {
  const { configPath } = resolveWebuiSettings({ environment });
  if (!existsSync(configPath)) {
    sendJson(response, 503, {
      error: {
        code: "configuration_unavailable",
        message: "Gateway 尚未初始化，请先运行 codexc init",
      },
    });
    return;
  }
  const gateway = loadGatewaySettings(environment);
  const serviceResults = await loadServiceStatusSummary(environment, serviceStatusCache);
  const platform = serviceResults.find((result) => result.platform !== null)?.platform ?? null;
  const entries = serviceResults.map((result) => result.entry);
  const services = {
    available: platform !== null,
    platform,
    healthy: platform === null ? null : entries.every((service) => service.running),
    entries,
  };
  sendJson(response, 200, {
    observedAt: new Date().toISOString(),
    revision: gateway.revision,
    gateway: {
      display: gateway.display,
      system: {
        approvalTimeoutSeconds: gateway.system.approvalTimeoutSeconds,
        sandbox: gateway.system.sandbox,
        defaultWorkspace: gateway.system.defaultWorkspace,
        defaultModel: gateway.system.defaultModel,
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
      { id: "gateway-config", label: "Gateway 与显示", command: "codexc config", detail: "进入 Gateway、显示和 WebUI 设置" },
      { id: "codex-setup", label: "Codex 默认值与 Provider", command: "codexc setup", detail: "进入 Codex 与 Provider 设置" },
      { id: "channels", label: "通讯渠道", command: "codexc setup", detail: "菜单路径：通讯渠道" },
      { id: "metrics-storage", label: "指标存储", command: "codexc config", detail: "菜单路径：指标存储" },
      { id: "service-status", label: "查看核心服务状态", command: "codexc service status all", detail: "查看 Gateway 与 App Server 状态" },
      { id: "service-webui", label: "查看 WebUI 状态", command: "codexc service status webui", detail: "查看 WebUI 服务状态" },
      { id: "service-restart", label: "重启核心服务", command: "codexc service restart all", detail: "重启 Gateway 与 App Server" },
    ],
  });
}

function toWebuiWeeklyQuota(quota) {
  if (quota === null) return null;
  return {
    ...quota,
    // 指标库保存的是秒级重置时间，WebUI 统一使用毫秒时间戳。
    resetsAt: quota.resetsAt === null ? null : quota.resetsAt * 1000,
  };
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
  const allowed = new Set(["range", "from", "to", "threadId", "turnId", "provider", "model", "operation", "status", "filter", "offset", "limit", "sort", "direction"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) throw new ApiError(400, "unsupported_parameter", "包含不支持的指标查询参数");
    if (key !== "provider" && url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "invalid_parameter", "除 provider 外的指标查询参数不能重复");
  }
  const values = Object.fromEntries(["threadId", "turnId", "provider", "model", "operation", "status"].filter((key) => url.searchParams.has(key)).map((key) => [key, url.searchParams.get(key)]));
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
  const sortKey = url.searchParams.get("sort") ?? "last";
  const sortDirection = url.searchParams.get("direction") ?? "desc";
  const sortKeys = threadId === undefined
    ? ["time", "last", "thread", "provider", "model", "turns", "requests", "input", "output", "compact"]
    : ["time", "last", "turn", "provider", "model", "requests", "failures", "input", "output", "compact"];
  if (![...sortKeys, "tokensPerSecond"].includes(sortKey)) throw new ApiError(400, "invalid_sort", "不支持该会话排序字段");
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
  const key = requestSortKeys[sort];
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
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(readFileSync(resolved));
  } catch {
    if (pathname === "/") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
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
    const { host, server } = createWebuiServer({
      environment: process.env,
      host: settings.host,
      port: settings.port,
      token: settings.token,
    });
    server.on("error", (error) => {
      writeCliMessage(
        "failure",
        `WebUI 启动失败：${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
    server.listen(settings.port, host, () => {
      const configNote = existsSync(settings.configPath)
        ? `（配置 [webui]：${settings.configPath}，CLI 参数优先）`
        : "";
      if (host === "0.0.0.0") {
        console.log(`Codex WebUI 已监听 0.0.0.0:${settings.port}（访问令牌保护）${configNote}`);
        console.log(`请通过服务器实际 IP 访问 http://<服务器IP>:${settings.port}/`);
        console.log("API 请求需要请求头 Authorization: Bearer <令牌>，或使用 ?token=<令牌> 打开。");
      } else {
        console.log(`Codex WebUI: http://${host}:${settings.port}/${configNote}`);
      }
      console.log("按 Ctrl+C 停止。");
    });
    const shutdown = () => {
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    writeCliMessage("failure", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
