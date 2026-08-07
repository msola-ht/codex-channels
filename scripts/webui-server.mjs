import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectMetricsDatabase,
  metricsRange,
  readWeeklyQuota,
} from "./metrics-database.mjs";
import { enrichCosts, loadDisplayContext } from "./metrics-export-format.mjs";
import { userDataDir } from "./runtime-config.mjs";
import {
  readGatewayConfig,
  validateWebuiConfigDocument,
} from "../runtime/gateway-config.mjs";
import { SqliteModelRequestMetricsStore } from "../dist/observability/index.js";
import { createDeepseekAccountAdapter } from "../dist/bootstrap/deepseek-account-adapter.js";

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
  if (!["127.0.0.1", "::1", "0.0.0.0"].includes(host)) {
    throw new Error("WebUI host 只允许 127.0.0.1、::1 或 0.0.0.0");
  }
  if (host === "0.0.0.0" && token === null) {
    throw new Error(
      "WebUI 绑定非回环地址时必须提供访问令牌（--token 或配置 [webui] token）",
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
  const cli = parseCliArgs(args);
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
  if (apiPath === "/deepseek-balance") {
    await handleDeepseekBalance(environment, response);
    return;
  }
  throw new ApiError(404, "not_found", `未知 API：${apiPath}`);
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
      "指标数据库版本不兼容，请停止 Gateway 后运行 codexc metrics upgrade",
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
      sendJson(response, 200, {
        generatedAt: new Date().toISOString(),
        threadId,
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
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    const page = store.page({
      startAtMs: range.startAtMs,
      endAtMs: range.endAtMs,
      offset,
      limit,
      sortKey: sort.key,
      sortDirection: sort.direction,
    });
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      records: page.records.map((record) =>
        enrichCosts(record, display, record.provider)),
      nextOffset: page.nextOffset,
    });
  } finally {
    store.close();
  }
}

function handleErrors(environment, url, response) {
  const range = parseRange(url);
  const store = openMetricsStore(environment, range.endAtMs);
  try {
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      errors: store.errors({
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
      }),
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
    throw new ApiError(400, "invalid_range", "range 只支持 24h、7d 或 30d");
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
      console.error(`WebUI 启动失败：${error instanceof Error ? error.message : String(error)}`);
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseCliArgs(args) {
  const settings = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      const raw = args[index + 1];
      if (raw === undefined || !/^[0-9]+$/u.test(raw)) {
        throw new Error("用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]");
      }
      const port = Number(raw);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("端口必须在 1 到 65535 之间");
      }
      settings.port = port;
      index += 1;
      continue;
    }
    if (argument === "--host") {
      const raw = args[index + 1];
      if (raw === undefined) {
        throw new Error("用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]");
      }
      settings.host = raw;
      index += 1;
      continue;
    }
    if (argument === "--token") {
      const raw = args[index + 1];
      if (raw === undefined || raw === "") {
        throw new Error("用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]");
      }
      settings.token = raw;
      index += 1;
      continue;
    }
    throw new Error(
      `未知参数：${argument}\n用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]`,
    );
  }
  return settings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
