import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { connect } from "node:net";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import * as clackPrompts from "@clack/prompts";

import { writeCliMessage } from "../runtime/cli-presentation.mjs";
import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { runCenterSettings } from "./metrics-config-menu.mjs";
import { parseIngestPayload } from "./metrics-center-payload.mjs";
import {
  assertMetricsCenterHost,
  DEFAULT_HOST,
  DEFAULT_PORT,
  resolveMetricsCenterSettings,
} from "./metrics-center-settings.mjs";

const maximumBodyBytes = 10 * 1024 * 1024;
const maximumListLimit = 200;
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_PATH = join(PACKAGE_DIR, "scripts", "metrics-center-schema.sql");

const insertRequestMetricSql = `
  INSERT INTO request_metrics
    (device_id, local_id, recorded_at_ms, provider, model, status, operation,
     thread_id, turn_id, input_tokens, cached_input_tokens, output_tokens,
     reasoning_output_tokens, total_tokens, cache_hit_rate, pricing_currency,
     total_cost_nanos, payload, ingested_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, local_id) DO UPDATE SET
    recorded_at_ms = excluded.recorded_at_ms,
    provider = excluded.provider,
    model = excluded.model,
    status = excluded.status,
    operation = excluded.operation,
    thread_id = excluded.thread_id,
    turn_id = excluded.turn_id,
    input_tokens = excluded.input_tokens,
    cached_input_tokens = excluded.cached_input_tokens,
    output_tokens = excluded.output_tokens,
    reasoning_output_tokens = excluded.reasoning_output_tokens,
    total_tokens = excluded.total_tokens,
    cache_hit_rate = excluded.cache_hit_rate,
    pricing_currency = excluded.pricing_currency,
    total_cost_nanos = excluded.total_cost_nanos,
    payload = excluded.payload,
    ingested_at_ms = excluded.ingested_at_ms
`;

const insertSubagentThreadSql = `
  INSERT INTO subagent_threads
    (device_id, thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms, ingested_at_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(device_id, thread_id) DO UPDATE SET
    parent_thread_id = excluded.parent_thread_id,
    parent_turn_id = COALESCE(excluded.parent_turn_id, subagent_threads.parent_turn_id),
    agent_path = excluded.agent_path,
    recorded_at_ms = excluded.recorded_at_ms,
    ingested_at_ms = excluded.ingested_at_ms
`;

const upsertDeviceSql = `
  INSERT INTO devices
    (device_id, first_seen_at_ms, last_seen_at_ms, last_ingested_at_ms, display_name)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET
    last_seen_at_ms = excluded.last_seen_at_ms,
    last_ingested_at_ms = excluded.last_ingested_at_ms,
    display_name = COALESCE(excluded.display_name, devices.display_name)
`;

export function openCentralDatabase(databasePath) {
  const existed = existsSync(databasePath);
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA busy_timeout = 10000;");
  database.exec(readFileSync(SCHEMA_PATH, "utf8"));
  if (!existed) database.exec("PRAGMA user_version = 1");
  chmodSync(databasePath, 0o600);
  const schemaVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (schemaVersion !== 1) {
    database.close();
    throw new Error(
      `指标中心数据库 Schema ${schemaVersion} 不受支持，请先运行 codexc center upgrade`,
    );
  }
  return database;
}

export function upgradeMetricsCenterDatabase(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error(`指标中心数据库不存在：${databasePath}`);
  }
  const backupPath = `${databasePath}.v0.${new Date().toISOString().replace(/[:.]/gu, "-")}.bak`;
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 10000;");
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version === 1) return { changed: false, backupPath: null, schemaVersion: 1 };
    if (version !== 0) throw new Error(`指标中心数据库 Schema ${version} 不受支持`);
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has("devices") || !tables.has("subagent_threads")) {
      throw new Error("指标中心数据库结构不完整，无法升级");
    }
    if (existsSync(backupPath)) throw new Error(`升级备份已存在：${backupPath}`);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(databasePath, backupPath);
    chmodSync(backupPath, 0o600);
    database.exec("BEGIN IMMEDIATE");
    try {
      const deviceColumns = database.prepare("PRAGMA table_info(devices)").all();
      if (!deviceColumns.some((column) => column.name === "display_name")) {
        database.exec("ALTER TABLE devices ADD COLUMN display_name TEXT");
      }
      const subagentColumns = database.prepare("PRAGMA table_info(subagent_threads)").all();
      if (!subagentColumns.some((column) => column.name === "parent_turn_id")) {
        database.exec("ALTER TABLE subagent_threads ADD COLUMN parent_turn_id TEXT");
      }
      database.exec("PRAGMA user_version = 1");
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    return { changed: true, backupPath, schemaVersion: 1 };
  } finally {
    database.close();
  }
}

export function createMetricsCenterServer({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  token = null,
  deviceToken = null,
  databasePath,
} = {}) {
  assertMetricsCenterHost(host);
  if (host === "0.0.0.0" && (token === null || deviceToken === null)) {
    throw new Error(
      "center 绑定非回环地址时必须同时提供查看令牌和设备上报令牌",
    );
  }
  if (token !== null && deviceToken !== null && token === deviceToken) {
    throw new Error("center 的查看令牌与设备上报令牌必须不同");
  }
  const database = openCentralDatabase(databasePath);
  const server = createServer((request, response) => {
    handleRequest({ token, deviceToken }, database, request, response).catch((error) => {
      console.error(error);
      if (error instanceof ApiError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (!response.headersSent) {
        sendJson(response, 500, { error: { code: "internal_error", message: "中心服务内部错误" } });
      } else {
        response.end();
      }
    });
  });
  return {
    host,
    port,
    server,
    token,
    deviceToken,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        try {
          database.close();
        } catch {
          // 数据库可能已关闭
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    }),
  };
}

export async function runCenterInfo({
  environment = process.env,
  output = process.stdout,
  json = false,
} = {}) {
  const settings = resolveMetricsCenterSettings({ environment });
  const listening = await probeListening(settings.host, settings.port);
  const candidates = settings.host === "0.0.0.0"
    ? listIpv4Candidates()
    : [];
  const viewHost = settings.host === "0.0.0.0"
    ? candidates[0] ?? "0.0.0.0"
    : formatHost(settings.host);
  const ingestEndpoints = (candidates.length > 0 ? candidates : [formatHost(settings.host)])
    .map((address) => `http://${address}:${settings.port}/api/ingest`);
  if (json) {
    output.write(`${JSON.stringify({
      running: listening,
      host: settings.host,
      port: settings.port,
      ingestEndpoints,
      viewEndpoint: `http://${viewHost}:${settings.port}`,
      viewTokenConfigured: settings.token !== null,
      deviceTokenConfigured: settings.deviceToken !== null,
      databasePath: settings.databasePath,
      configPath: settings.configPath,
    }, null, 2)}\n`);
    return settings;
  }
  output.write(`中心服务：${listening ? "运行中" : "未运行"}\n`);
  output.write(`监听地址：${formatHost(settings.host)}:${settings.port}\n`);
  output.write("设备上报端点：\n");
  if (candidates.length > 0) {
    for (const address of candidates) {
      output.write(`  http://${address}:${settings.port}/api/ingest\n`);
    }
    output.write("  （检测到的本机非回环 IPv4 地址；公网环境请以实际公网 IP/域名 + HTTPS 为准）\n");
  } else {
    output.write(`  http://${formatHost(settings.host)}:${settings.port}/api/ingest\n`);
  }
  output.write(`全局查看端点：http://${viewHost}:${settings.port}\n`);
  output.write(
    `查看令牌：${settings.token === null
      ? "未设置（绑定 0.0.0.0 时必须设置）"
      : `已设置（${maskToken(settings.token)}）`}\n`,
  );
  output.write(
    `设备上报令牌：${settings.deviceToken === null
      ? "未设置（绑定 0.0.0.0 时必须设置）"
      : `已设置（${maskToken(settings.deviceToken)}）`}\n`,
  );
  output.write(`中心数据库：${settings.databasePath}\n`);
  output.write(`配置：${settings.configPath} 的 [metrics.center]\n`);
  output.write("公网接入建议：host = \"0.0.0.0\" + 两类独立令牌，并在 nginx/Caddy 上套 HTTPS。\n");
  return settings;
}

async function handleRequest({ token, deviceToken }, database, request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders({
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
    }));
    response.end();
    return;
  }
  if (url.pathname === "/api/health") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: { code: "not_found", message: "not found" } });
    return;
  }
  const requiredToken = request.method === "POST" && url.pathname === "/api/ingest"
    ? deviceToken
    : token;
  if (requiredToken !== null && !authorized(request, requiredToken)) {
    sendJson(response, 401, { error: { code: "unauthorized", message: "需要有效的访问令牌" } });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/ingest") {
    await handleIngest(request, database, response);
    return;
  }
  if (request.method !== "GET") {
    sendJson(response, 405, { error: { code: "method_not_allowed", message: "中心服务只提供 GET 查询与 POST 上报" } });
    return;
  }
  if (url.pathname === "/api/overview") {
    handleOverview(url, database, response);
    return;
  }
  if (url.pathname === "/api/daily") {
    handleDaily(url, database, response);
    return;
  }
  if (url.pathname === "/api/requests") {
    handleRequests(url, database, response);
    return;
  }
  if (url.pathname === "/api/subagents") {
    handleSubagents(url, database, response);
    return;
  }
  if (url.pathname === "/api/devices") {
    handleDevices(database, response);
    return;
  }
  sendJson(response, 404, { error: { code: "not_found", message: "not found" } });
}

async function handleIngest(request, database, response) {
  const body = await readRequestBody(request);
  let parsedBody;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    sendJson(response, 400, { error: { code: "invalid_json", message: "请求体不是有效 JSON" } });
    return;
  }
  const parsed = parseIngestPayload(parsedBody);
  if (!parsed.ok) {
    sendJson(response, 400, { error: { code: "invalid_payload", message: parsed.error } });
    return;
  }

  const nowMs = Date.now();
  const insertRequest = database.prepare(insertRequestMetricSql);
  const insertSubagent = database.prepare(insertSubagentThreadSql);
  const upsertDevice = database.prepare(upsertDeviceSql);
  let insertedRequests = 0;
  let insertedSubagents = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of parsed.requestMetrics) {
      const result = insertRequest.run(
        parsed.deviceId,
        row.localId,
        row.recordedAtMs,
        row.provider ?? null,
        row.model ?? null,
        row.status ?? null,
        row.operation ?? null,
        row.threadId ?? null,
        row.turnId ?? null,
        row.inputTokens ?? null,
        row.cachedInputTokens ?? null,
        row.outputTokens ?? null,
        row.reasoningOutputTokens ?? null,
        row.totalTokens ?? null,
        row.cacheHitRate ?? null,
        row.pricing?.currency ?? null,
        row.totalCostNanos ?? null,
        JSON.stringify(row),
        nowMs,
      );
      if (Number(result.changes) > 0) insertedRequests += 1;
    }
    for (const row of parsed.subagentThreads) {
      const result = insertSubagent.run(
        parsed.deviceId,
        row.threadId,
        row.parentThreadId ?? null,
        row.parentTurnId ?? null,
        row.agentPath ?? null,
        row.recordedAtMs,
        nowMs,
      );
      if (Number(result.changes) > 0) insertedSubagents += 1;
    }
    upsertDevice.run(
      parsed.deviceId,
      nowMs,
      nowMs,
      nowMs,
      parsed.deviceName ?? null,
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  sendJson(response, 200, {
    ok: true,
    deviceId: parsed.deviceId,
    insertedRequests,
    insertedSubagents,
  });
}

function handleOverview(url, database, response) {
  const deviceId = url.searchParams.get("device") ?? "";
  const hasDevice = deviceId !== "";
  const where = hasDevice ? "WHERE device_id = ?" : "";
  const params = hasDevice ? [deviceId] : [];
  const totals = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM devices ${hasDevice ? "WHERE device_id = ?" : ""}) AS device_count,
      (SELECT COUNT(*) FROM request_metrics ${where}) AS request_count,
      (SELECT COUNT(*) FROM subagent_threads ${where}) AS subagent_count,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens,
      MAX(recorded_at_ms) AS last_recorded_at_ms
    FROM request_metrics
    ${where}
  `).get(...(hasDevice ? [deviceId, deviceId, deviceId, deviceId] : []));
  const costs = database.prepare(`
    SELECT COALESCE(pricing_currency, 'unknown') AS currency,
           COUNT(*) AS request_count,
           COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM request_metrics
    ${where}
    GROUP BY pricing_currency
    ORDER BY request_count DESC
  `).all(...params);
  const providers = database.prepare(`
    SELECT provider,
           COUNT(*) AS request_count,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM request_metrics
    ${where}
    GROUP BY provider
    ORDER BY request_count DESC
    LIMIT 50
  `).all(...params);
  sendJson(response, 200, { totals, costsByCurrency: costs, providers });
}

function handleRequests(url, database, response) {
  const limit = clampLimit(url.searchParams.get("limit"), 50);
  const offset = clampOffset(url.searchParams.get("offset"));
  const deviceId = url.searchParams.get("device") ?? "";
  const provider = url.searchParams.get("provider") ?? "";
  const status = url.searchParams.get("status") ?? "";
  const sortColumn = requestSortColumns[url.searchParams.get("sort") ?? "time"]
    ?? "recorded_at_ms";
  const direction = url.searchParams.get("direction") === "asc" ? "ASC" : "DESC";
  const clauses = [];
  const params = [];
  if (deviceId) {
    clauses.push("device_id = ?");
    params.push(deviceId);
  }
  if (provider) {
    clauses.push("provider = ?");
    params.push(provider);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = Number(
    database.prepare(
      `SELECT COUNT(*) AS n FROM request_metrics ${where}`,
    ).get(...params)?.n ?? 0,
  );
  const rows = database.prepare(`
    SELECT device_id, local_id, recorded_at_ms, provider, model, status, operation,
           input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
           total_tokens, cache_hit_rate, pricing_currency, total_cost_nanos
    FROM request_metrics
    ${where}
    ORDER BY ${sortColumn} ${direction}, device_id ASC, local_id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  sendJson(response, 200, { requests: rows, total });
}

function handleDaily(url, database, response) {
  const deviceId = url.searchParams.get("device") ?? "";
  const days = clampDays(url.searchParams.get("days"), 30);
  const sinceMs = Date.now() - days * 86_400_000;
  const clauses = ["recorded_at_ms >= ?"];
  const params = [sinceMs];
  if (deviceId) {
    clauses.push("device_id = ?");
    params.push(deviceId);
  }
  const rows = database.prepare(`
    SELECT date(recorded_at_ms / 1000, 'unixepoch') AS day,
           COUNT(*) AS request_count,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens,
           COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
           COALESCE(SUM(total_tokens), 0) AS total_tokens,
           COALESCE(SUM(total_cost_nanos), 0) AS total_cost_nanos
    FROM request_metrics
    WHERE ${clauses.join(" AND ")}
    GROUP BY day
    ORDER BY day ASC
  `).all(...params);
  sendJson(response, 200, { daily: rows });
}

const requestSortColumns = {
  time: "recorded_at_ms",
  device: "device_id",
  provider: "provider",
  model: "model",
  status: "status",
  input: "input_tokens",
  cached: "cached_input_tokens",
  output: "output_tokens",
  cost: "total_cost_nanos",
};

function handleSubagents(url, database, response) {
  const limit = clampLimit(url.searchParams.get("limit"), 50);
  const offset = clampOffset(url.searchParams.get("offset"));
  const deviceId = url.searchParams.get("device") ?? "";
  const params = deviceId ? [deviceId] : [];
  const where = deviceId ? "WHERE device_id = ?" : "";
  const rows = database.prepare(`
    SELECT device_id, thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms
    FROM subagent_threads
    ${where}
    ORDER BY recorded_at_ms DESC, thread_id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  sendJson(response, 200, { subagents: rows });
}

function handleDevices(database, response) {
  const rows = database.prepare(`
    SELECT d.device_id, d.first_seen_at_ms, d.last_seen_at_ms, d.last_ingested_at_ms,
           COALESCE(d.display_name, d.device_id) AS display_name,
           (SELECT COUNT(*) FROM request_metrics r WHERE r.device_id = d.device_id)
             AS request_count,
           (SELECT COUNT(*) FROM subagent_threads s WHERE s.device_id = d.device_id)
             AS subagent_count
    FROM devices d
    ORDER BY d.last_seen_at_ms DESC
  `).all();
  sendJson(response, 200, { devices: rows });
}

function authorized(request, token) {
  const header = request.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    return false;
  }
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBodyBytes) {
        reject(new ApiError(413, "payload_too_large", "上报体超过大小限制"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function clampLimit(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, maximumListLimit);
}

function clampDays(raw, fallback) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, 365);
}

function clampOffset(raw) {
  const value = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

function sendJson(response, status, payload) {
  response.writeHead(status, corsHeaders({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  }));
  response.end(JSON.stringify(payload));
}

function corsHeaders(headers) {
  return {
    ...headers,
    "access-control-allow-origin": "*",
    "access-control-max-age": "86400",
  };
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function main() {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "info") {
      runCenterInfo({ json: args[1] === "--json" }).catch((error) => {
        writeCliMessage("failure", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
      return;
    }
    if (args[0] === "config") {
      if (!process.stdout.isTTY) {
        const settings = resolveMetricsCenterSettings({ environment: process.env });
        console.log(`配置文件：${settings.configPath}`);
        console.log("中心服务设置保存在 [metrics.center] 段。");
        return;
      }
      runCenterSettings({
        environment: process.env,
        output: process.stdout,
        prompts: clackPrompts,
        writeConfig: writeGatewayConfig,
      }).catch((error) => {
        writeCliMessage("failure", error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
      return;
    }
    if (args[0] === "upgrade") {
      const settings = resolveMetricsCenterSettings({ environment: process.env });
      const result = upgradeMetricsCenterDatabase(settings.databasePath);
      writeCliMessage(
        result.changed ? "success" : "note",
        result.changed
          ? `指标中心数据库已升级到 Schema ${result.schemaVersion}`
          : `指标中心数据库已经是 Schema ${result.schemaVersion}`,
      );
      if (result.backupPath !== null) console.log(`升级前备份：${result.backupPath}`);
      return;
    }
    if (args[0] === "--help" || args[0] === "-h") {
      console.log("用法：codexc center [--host 地址] [--port 端口] [--database 路径]");
      console.log("      codexc center info [--json]     查看中心地址、双令牌状态与运行状态");
      console.log("      codexc center config   交互配置 [metrics.center]");
      console.log("      codexc center upgrade  升级中心数据库并保留备份");
      return;
    }
    const settings = resolveMetricsCenterSettings({ args });
    const { host, server } = createMetricsCenterServer({
      environment: process.env,
      host: settings.host,
      port: settings.port,
      token: settings.token,
      deviceToken: settings.deviceToken,
      databasePath: settings.databasePath,
    });
    server.on("error", (error) => {
      writeCliMessage(
        "failure",
        `中心服务启动失败：${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
    server.listen(settings.port, host, () => {
      const configNote = existsSync(settings.configPath)
        ? `（配置 [metrics.center]：${settings.configPath}，CLI 参数优先）`
        : "";
      if (host === "0.0.0.0") {
        console.log(`Codex 指标中心已监听 0.0.0.0:${settings.port}（访问令牌保护）${configNote}`);
      } else {
        console.log(`Codex 指标中心: http://${host}:${settings.port}/${configNote}`);
      }
      console.log(`中心数据库：${settings.databasePath}`);
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

function probeListening(host, port) {
  return new Promise((resolve) => {
    const targetHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const socket = connect({ host: targetHost, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function listIpv4Candidates() {
  const addresses = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return [...new Set(addresses)];
}

function formatHost(host) {
  return host === "::1" ? "[::1]" : host;
}

function maskToken(token) {
  if (typeof token !== "string" || token.length === 0) return "****";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
