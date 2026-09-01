import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectMetricsDatabase,
  metricsDatabaseCanUpgrade,
  metricsRange,
  requireCompatibleMetricsDatabase,
  readWeeklyQuota,
} from "./metrics-database-access.mjs";
import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { enrichCosts, loadDisplayContext } from "./metrics-export-format.mjs";
import { userDataDir } from "./runtime-config.mjs";
import {
  assertWebuiHost,
  parseWebuiCliArgs,
} from "./webui-command-options.mjs";
import {
  readGatewayConfig,
  validateMetricsViewConfigDocument,
  validateWebuiConfigDocument,
} from "../runtime/gateway-config.mjs";
import { SqliteModelRequestMetricsStore } from "../dist/observability/index.js";
import { createDeepseekAccountAdapter } from "../dist/bootstrap/deepseek-account-adapter.js";
import { createOpencodeGoAccountAdapter } from "../dist/bootstrap/opencode-go-account-adapter.js";
import {
  loadOpencodeGoAccounts,
  opencodeGoProviderId,
} from "../runtime/opencode-go-accounts.mjs";

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
  speed: "outputTokensPerSecond",
  ttft: "ttftMs",
  duration: "requestDurationMs",
  cost: "totalCostNanos",
};
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createWebuiServer({
  environment = process.env,
  host = DEFAULT_HOST,
  staticDir = join(PACKAGE_DIR, "webui", "dist"),
  token = null,
} = {}) {
  assertWebuiHost(host);
  if (host === "0.0.0.0" && token === null) {
    throw new Error(
      "WebUI 绑定非回环地址时必须提供访问令牌（请通过 codexc config 或配置 [webui] token 设置）",
    );
  }
  const server = createServer((request, response) => {
    handleRequest(environment, staticDir, host, token, request, response);
  });
  return { host, server, staticDir, token };
}

export function resolveWebuiSettings({
  args = [],
  environment = process.env,
} = {}) {
  const cli = parseWebuiCliArgs(args);
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfigFile
    ? resolve(explicitConfigFile)
    : join(userDataDir(environment), "config.toml");
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

async function handleRequest(environment, staticDir, host, token, request, response) {
  try {
    if (request.method !== "GET") {
      sendJson(response, 405, {
        error: { code: "method_not_allowed", message: "WebUI 只提供只读 GET 接口" },
      });
      return;
    }
    // 只取 pathname 与查询参数，固定回环 base，避免协议相对路径被重解析。
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      if (token !== null && !authorized(request, token)) {
        sendJson(response, 401, {
          error: { code: "unauthorized", message: "需要有效的访问令牌" },
        });
        return;
      }
      await routeApi(environment, url, response);
      return;
    }
    serveStatic(staticDir, url.pathname, response);
  } catch (error) {
    if (error instanceof ApiError) {
      sendJson(response, error.status, { error: { code: error.code, message: error.message } });
      return;
    }
    console.error(error);
    sendJson(response, 500, {
      error: { code: "internal_error", message: "WebUI 内部错误" },
    });
  }
}

function authorized(request, token) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length
    && timingSafeEqual(provided, expected);
}

async function routeApi(environment, url, response) {
  const path = url.pathname;
  if (!path.startsWith(`${API_PREFIX}/`)) {
    throw new ApiError(404, "not_found", `未知 API：${path}`);
  }
  const apiPath = path.slice(API_PREFIX.length);
  if (apiPath === "/overview") {
    handleOverview(environment, url, response);
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
  if (apiPath === "/errors") {
    handleErrors(environment, url, response);
    return;
  }
  if (apiPath === "/settings") {
    handleSettings(environment, response);
    return;
  }
  if (apiPath === "/health") {
    sendJson(response, 200, { ok: true, service: "webui" });
    return;
  }
  if (apiPath === "/deepseek-balance") {
    await handleDeepseekBalance(environment, response);
    return;
  }
  if (apiPath === "/opencode-go-usage") {
    await handleOpencodeGoUsage(environment, response);
    return;
  }
  if (apiPath === "/global/overview") {
    await proxyGlobalCenter(environment, url, response, "/api/overview");
    return;
  }
  if (apiPath === "/global/requests") {
    await proxyGlobalCenter(environment, url, response, "/api/requests");
    return;
  }
  if (apiPath === "/global/devices") {
    await proxyGlobalCenter(environment, url, response, "/api/devices");
    return;
  }
  if (apiPath === "/global/daily") {
    await proxyGlobalCenter(environment, url, response, "/api/daily");
    return;
  }
  if (apiPath === "/global/quota") {
    await proxyGlobalCenter(environment, url, response, "/api/quota");
    return;
  }
  throw new ApiError(404, "not_found", `未知 API：${apiPath}`);
}

async function proxyGlobalCenter(environment, url, response, upstreamPath) {
  const settings = loadMetricsViewSettings(environment);
  if (!settings.enabled) {
    throw new ApiError(
      503,
      "metrics_view_unavailable",
      "全局视图未启用：请通过 codexc config 配置 [metrics.view] 的中心地址与令牌",
    );
  }
  const base = (settings.endpoint ?? "").replace(/\/+$/u, "");
  const target = `${base}${upstreamPath}${url.search}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const upstream = await fetch(target, {
      headers: settings.token === undefined
        ? {}
        : { authorization: `Bearer ${settings.token}` },
      signal: controller.signal,
    });
    const body = await upstream.text();
    response.writeHead(upstream.status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    throw new ApiError(
      502,
      "metrics_view_unreachable",
      `中心服务不可达：${settings.endpoint ?? "未配置"}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

function loadMetricsViewSettings(environment) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfigFile
    ? resolve(explicitConfigFile)
    : join(userDataDir(environment), "config.toml");
  if (!existsSync(configPath)) {
    return { enabled: false };
  }
  return validateMetricsViewConfigDocument(readGatewayConfig(configPath));
}

async function handleDeepseekBalance(environment, response) {
  const adapter = createDeepseekAccountAdapter({ environment });
  try {
    const usage = await adapter.accountUsage();
    sendJson(response, 200, {
      available: usage.available,
      balances: usage.balances.map((balance) => ({
        currency: balance.currency,
        totalBalance: balance.totalBalance,
        grantedBalance: balance.grantedBalance,
        toppedUpBalance: balance.toppedUpBalance,
      })),
    });
  } catch {
    sendJson(response, 200, {
      available: false,
      balances: [],
    });
  }
}

async function handleOpencodeGoUsage(environment, response) {
  let metricsDatabasePath;
  try {
    metricsDatabasePath = requireCompatibleMetricsDatabase(environment);
  } catch {
    metricsDatabasePath = undefined;
  }
  const accounts = loadOpencodeGoAccounts(environment);
  const results = await Promise.allSettled(accounts.map(async (account) => {
    const adapter = createOpencodeGoAccountAdapter({
      provider: opencodeGoProviderId(account.id),
      environment,
      metricsDatabasePath,
    });
    const usage = await adapter.accountUsage();
    return {
      account: account.id,
      default: account.default,
      available: usage.available,
      windows: usage.windows.map((window) => ({
        windowId: window.windowId,
        label: window.label,
        usedPercent: window.usedPercent,
        // 指标/账户接口统一使用秒级重置时间，WebUI 前端使用毫秒时间戳。
        resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
        status: window.status,
        localTokens: window.localTokens ?? null,
      })),
      modelUsage: usage.modelUsage ?? [],
    };
  }));
  const accountUsages = accounts.map((account, index) => {
    const result = results[index];
    return result?.status === "fulfilled"
      ? result.value
      : {
          account: account.id,
          default: account.default,
          available: false,
          windows: [],
          modelUsage: [],
        };
  });
  if (accounts.length === 0) {
    sendJson(response, 200, { accounts: [] });
    return;
  }
  sendJson(response, 200, { accounts: accountUsages });
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

function handleOverview(environment, url, response) {
  const range = parseRange(url);
  const display = displayForCurrency(
    loadDisplayContext(environment),
    parseCurrency(url),
  );
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const global = store.aggregate({
      dimension: "global",
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
    });
    const providers = store.aggregate({
      dimension: "provider",
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
    });
    const errors = store.errors({
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
    });
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      global: enrichGlobalCosts(
        enrichCosts(global.aggregate, display),
        display,
      ),
      providers: providers.groups.map((group) => ({
        ...group,
        aggregate: enrichCosts(group.aggregate, display, group.provider),
      })),
      errors,
      weeklyQuota: toWebuiWeeklyQuota(readWeeklyQuota(store, range.endAtMs)),
    });
  } finally {
    store.close();
  }
}

function enrichGlobalCosts(aggregate, display) {
  if (
    aggregate === null
    || display.priceCurrency !== "cny"
    || aggregate.totalCostNanos === null
    || aggregate.pricingCurrency !== "USD"
    || !display.exchangeRate
  ) {
    return aggregate;
  }
  const converted = Math.round(aggregate.totalCostNanos * display.exchangeRate.usdToCny);
  return Number.isSafeInteger(converted)
    ? { ...aggregate, totalCostCnyNanos: converted }
    : aggregate;
}

function handleThreads(environment, url, response) {
  const display = displayForCurrency(
    loadDisplayContext(environment),
    parseCurrency(url),
  );
  const store = openMetricsStore(environment);
  try {
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      threads: store.threadList().map((thread) =>
        enrichCosts(thread, display, thread.provider)),
    });
  } finally {
    store.close();
  }
}

function handleThreadDetail(environment, rawThreadId, view, url, response) {
  const threadId = parseThreadId(rawThreadId);
  const display = displayForCurrency(
    loadDisplayContext(environment),
    parseCurrency(url),
  );
  const store = openMetricsStore(environment);
  try {
    if (view === "run") {
      const summary = store.threadSummary(threadId);
      const provider = summary.latestTurn?.provider ?? null;
      const subagent = store.subagentThread(threadId);
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        threadId,
        agentPath: subagent.agentPath,
        parentThreadId: subagent.parentThreadId,
        parentTurnId: subagent.parentTurnId,
        latestTurn: enrichCosts(summary.latestTurn, display, provider),
        threadAggregate: enrichCosts(summary.threadAggregate, display, provider),
        latestDirectApi: enrichCosts(
          summary.latestDirectApi,
          display,
          summary.latestDirectApi?.provider ?? null,
        ),
      });
      return;
    }
    sendJson(response, 200, {
      generatedAt: new Date().toISOString(),
      threadId,
      turns: store.threadTurnSummaries(threadId).map((turn) =>
        enrichCosts(turn, display, turn.provider)),
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
  const display = displayForCurrency(
    loadDisplayContext(environment),
    parseCurrency(url),
  );
  const offset = parseBoundedInt(url.searchParams.get("offset"), "offset", 0, null, 0);
  const sort = parseRequestSort(url);
  const limit = parseBoundedInt(
    url.searchParams.get("limit"),
    "limit",
    1,
    500,
    100,
  );
  const filter = parseRequestFilter(url);
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const page = store.page({
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
      offset,
      limit,
      sortKey: sort.key,
      sortDirection: sort.direction,
      filter,
    });
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      records: page.records.map((record) =>
        enrichCosts(record, display, record.provider)),
      nextOffset: page.nextOffset,
      total: page.matchedTotal,
    });
  } finally {
    store.close();
  }
}

function handleErrors(environment, url, response) {
  const range = parseRange(url);
  const display = displayForCurrency(
    loadDisplayContext(environment),
    parseCurrency(url),
  );
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
    const page = store.page({
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
      offset,
      limit,
      sortKey: "recordedAtMs",
      sortDirection: "desc",
      onlyFailures: true,
    });
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      errors: store.errors({
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
      }),
      records: page.records.map((record) => enrichCosts(record, display, record.provider)),
      nextOffset: page.nextOffset,
      total: page.matchedTotal,
    });
  } finally {
    store.close();
  }
}

function handleSettings(environment, response) {
  const display = loadDisplayContext(environment);
  sendJson(response, 200, {
    currency: display.priceCurrency,
    exchangeRate: display.exchangeRate,
  });
}

function parseCurrency(url) {
  const value = url.searchParams.get("currency");
  if (value === null) return null;
  if (value !== "cny" && value !== "usd") {
    throw new ApiError(400, "invalid_currency", "currency 只支持 cny 或 usd");
  }
  return value;
}

function displayForCurrency(display, currency) {
  if (currency === null) return display;
  return {
    ...display,
    priceCurrency: currency,
  };
}

function toWebuiWeeklyQuota(quota) {
  if (quota === null) return null;
  return {
    ...quota,
    // 指标库保存的是秒级重置时间，WebUI 统一使用毫秒时间戳。
    resetsAt: quota.resetsAt === null ? null : quota.resetsAt * 1000,
  };
}

function parseRange(url) {
  const name = url.searchParams.get("range") ?? "24h";
  try {
    return metricsRange(name, Date.now());
  } catch {
    throw new ApiError(400, "invalid_range", "range 不支持该时间范围");
  }
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

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function main() {
  try {
    const settings = resolveWebuiSettings({ args: process.argv.slice(2) });
    const { host, server } = createWebuiServer({
      environment: process.env,
      host: settings.host,
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
