import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inspectMetricsDatabase,
  metricsRange,
  readWeeklyQuota,
} from "./metrics-database.mjs";
import { enrichCosts, loadDisplayContext } from "./metrics-export-format.mjs";
import { SqliteModelRequestMetricsStore } from "../dist/observability/index.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const API_PREFIX = "/api/v1";
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
  const server = createServer((request, response) => {
    handleRequest(environment, staticDir, host, token, request, response);
  });
  return { host, server, staticDir, token };
}

function handleRequest(environment, staticDir, host, token, request, response) {
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
      routeApi(environment, url, response);
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

function routeApi(environment, url, response) {
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
    handleThreads(environment, response);
    return;
  }
  const threadMatch = apiPath.match(/^\/threads\/([^/]+)\/(run|turns)$/u);
  if (threadMatch) {
    handleThreadDetail(environment, threadMatch[1], threadMatch[2], response);
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
      "指标数据库版本不兼容，请停止 Gateway 后运行 codexc metrics upgrade",
    );
  }
  return new SqliteModelRequestMetricsStore(status.databasePath, endAtMs, {
    readOnly: true,
  });
}

function handleOverview(environment, url, response) {
  const range = parseRange(url);
  const display = loadDisplayContext(environment);
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
      weeklyQuota: readWeeklyQuota(store, range.endAtMs),
    });
  } finally {
    store.close();
  }
}

function enrichGlobalCosts(aggregate, display) {
  if (
    aggregate === null
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

function handleThreads(environment, response) {
  const display = loadDisplayContext(environment);
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

function handleThreadDetail(environment, rawThreadId, view, response) {
  const threadId = parseThreadId(rawThreadId);
  const display = loadDisplayContext(environment);
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
  const range = parseRange(url);
  const display = loadDisplayContext(environment);
  const afterId = parseBoundedInt(url.searchParams.get("afterId"), "afterId", 0, null, 0);
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
      afterId,
      limit,
    });
    sendJson(response, 200, {
      range,
      generatedAt: new Date(range.endAtMs).toISOString(),
      records: page.records.map((record) =>
        enrichCosts(record, display, record.provider)),
      nextAfterId: page.nextAfterId,
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

function parseRange(url) {
  const name = url.searchParams.get("range") ?? "24h";
  try {
    return metricsRange(name, Date.now());
  } catch {
    throw new ApiError(400, "invalid_range", "range 只支持 24h、7d 或 30d");
  }
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
  const parsed = parseCliArgs(process.argv.slice(2));
  const { host, server } = createWebuiServer({
    environment: process.env,
    host: parsed.host,
    token: parsed.token,
  });
  server.on("error", (error) => {
    console.error(`WebUI 启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
  server.listen(parsed.port, host, () => {
    if (host === "0.0.0.0") {
      if (parsed.token === null) {
        console.log(`Codex WebUI 已监听 0.0.0.0:${parsed.port}（未启用访问令牌）`);
        console.log(`请通过服务器实际 IP 访问 http://<服务器IP>:${parsed.port}/`);
        console.warn("警告：未启用访问令牌，指标数据对网络公开，仅供测试。");
      } else {
        console.log(`Codex WebUI 已监听 0.0.0.0:${parsed.port}（访问令牌保护）`);
        console.log(`请通过服务器实际 IP 访问 http://<服务器IP>:${parsed.port}/`);
        console.log("API 请求需要请求头 Authorization: Bearer <令牌>。");
      }
    } else {
      console.log(`Codex WebUI: http://${host}:${parsed.port}/`);
    }
    console.log("按 Ctrl+C 停止。");
  });
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function parseCliArgs(args) {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let token = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--port") {
      const raw = args[index + 1];
      if (raw === undefined || !/^[0-9]+$/u.test(raw)) {
        throw new Error("用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]");
      }
      port = Number(raw);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new Error("端口必须在 1 到 65535 之间");
      }
      index += 1;
      continue;
    }
    if (argument === "--host") {
      const raw = args[index + 1];
      if (raw === undefined) {
        throw new Error("用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]");
      }
      host = raw;
      index += 1;
      continue;
    }
    if (argument === "--token") {
      const raw = args[index + 1];
      if (raw === undefined || raw === "") {
        throw new Error("用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]");
      }
      token = raw;
      index += 1;
      continue;
    }
    throw new Error(
      `未知参数：${argument}\n用法：codexc webui [--host 地址] [--port 端口] [--token 令牌]`,
    );
  }
  return { host, port, token };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
