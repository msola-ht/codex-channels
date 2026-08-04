import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  renameSync,
} from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { providerMetricsSocketPath } from "../runtime/model-provider-runtime.mjs";
import {
  acquireRequestMetricsDatabaseLock,
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
} from "../dist/observability/index.js";
import {
  locateUserConfig,
  resolveConfiguredPath,
} from "./runtime-config.mjs";

export function inspectMetricsDatabase(environment = process.env) {
  const databasePath = resolveMetricsDatabasePath(environment);
  if (!existsSync(databasePath)) {
    return {
      compatible: false,
      count: null,
      databasePath,
      exists: false,
      schemaVersion: null,
    };
  }

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const schemaVersion = readSchemaVersion(database);
    const count = hasTable(database, "model_request_metrics")
      ? Number(database.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get()?.count)
      : null;
    return {
      compatible: schemaVersion === modelRequestMetricsSchemaVersion,
      count,
      databasePath,
      exists: true,
      schemaVersion,
    };
  } finally {
    database.close();
  }
}

export function resetMetricsDatabase(
  environment = process.env,
  options = {},
) {
  const runtime = resolveMetricsRuntime(environment);
  const gatewayRunning = options.gatewayRunning ?? (() => isGatewayRunning(environment));
  if (
    gatewayRunning()
    || runtime.metricsSocketPaths.some(metricsSocketIsActive)
  ) {
    throw new Error("Gateway 仍在运行；请先执行 codexc service stop gateway，再重试");
  }

  const databasePath = runtime.databasePath;
  if (!existsSync(databasePath)) {
    return {
      backupPath: null,
      changed: false,
      databasePath,
      previousSchemaVersion: null,
    };
  }
  const lock = acquireRequestMetricsDatabaseLock(databasePath);
  try {
    const status = inspectMetricsDatabase(environment);
    if (!status.exists) {
      return {
        backupPath: null,
        changed: false,
        databasePath: status.databasePath,
        previousSchemaVersion: null,
      };
    }

    checkpoint(status.databasePath);
    const now = options.now ?? (() => new Date());
    const version = status.schemaVersion ?? "unknown";
    const backupPath = `${status.databasePath}.v${version}.${backupTimestamp(now())}.bak`;
    if (existsSync(backupPath)) {
      throw new Error(`指标数据库备份已存在：${backupPath}`);
    }
    renameSync(status.databasePath, backupPath);
    chmodSync(backupPath, 0o600);
    return {
      backupPath,
      changed: true,
      databasePath: status.databasePath,
      previousSchemaVersion: status.schemaVersion,
    };
  } finally {
    lock.release();
  }
}

export function readMetricsReport(environment = process.env, options = {}) {
  const range = metricsRange(options.range ?? "30d", options.nowMs ?? Date.now());
  const dimension = metricsDimension(options.group ?? "models");
  const databasePath = requireReadableMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    range.endAtMs,
    { readOnly: true },
  );
  try {
    return {
      format: "codex-connect-request-metrics-report",
      version: 1,
      generatedAt: new Date(range.endAtMs).toISOString(),
      range,
      report: store.aggregate({
        dimension,
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
      }),
      errors: store.errors({
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
      }),
    };
  } finally {
    store.close();
  }
}

export function readMetricsExport(environment = process.env, options = {}) {
  const range = metricsRange(options.range ?? "30d", options.nowMs ?? Date.now());
  const databasePath = requireReadableMetricsDatabase(environment);
  const store = new SqliteModelRequestMetricsStore(
    databasePath,
    range.endAtMs,
    { readOnly: true },
  );
  try {
    const records = [];
    let afterId;
    do {
      const page = store.page({
        startAtMs: range.startAtMs,
        endAtMs: range.endAtMs,
        ...(afterId === undefined ? {} : { afterId }),
        limit: 500,
      });
      records.push(...page.records);
      afterId = page.nextAfterId ?? undefined;
    } while (afterId !== undefined);
    return {
      format: "codex-connect-request-metrics-export",
      version: 1,
      generatedAt: new Date(range.endAtMs).toISOString(),
      range,
      records,
    };
  } finally {
    store.close();
  }
}

function requireReadableMetricsDatabase(environment) {
  const status = inspectMetricsDatabase(environment);
  if (!status.exists) throw new Error(`指标数据库尚未创建：${status.databasePath}`);
  if (!status.compatible) {
    throw new Error("模型请求指标数据库版本不兼容；请停止 Gateway 后运行 codexc metrics reset");
  }
  return status.databasePath;
}

function resolveMetricsDatabasePath(environment) {
  return resolveMetricsRuntime(environment).databasePath;
}

function resolveMetricsRuntime(environment) {
  const { configPath, dataDir } = locateUserConfig(environment);
  const document = readGatewayConfig(configPath);
  const storage = isRecord(document.storage) ? document.storage : {};
  const codex = isRecord(document.codex) ? document.codex : {};
  const stateDatabasePath = resolveConfiguredPath(
    typeof storage.database_path === "string" ? storage.database_path : undefined,
    dataDir,
    "data/gateway.sqlite3",
  );
  const appServerSocketPath = resolveConfiguredPath(
    typeof codex.socket_path === "string" ? codex.socket_path : undefined,
    dataDir,
    "runtime/codex-app-server.sock",
  );
  return {
    databasePath: requestMetricsDatabasePath(stateDatabasePath),
    metricsSocketPaths: ["openai", "deepseek"].map((provider) =>
      providerMetricsSocketPath(appServerSocketPath, provider)
    ),
  };
}

function readSchemaVersion(database) {
  if (!hasTable(database, "schema_metadata")) return null;
  const row = database.prepare(`
    SELECT value FROM schema_metadata WHERE name = 'schema_version'
  `).get();
  const value = Number(row?.value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hasTable(database, name) {
  return database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) !== undefined;
}

function checkpoint(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 1000;");
    const result = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (Number(result?.busy) !== 0) {
      throw new Error("指标数据库仍被其他进程占用；请确认 Gateway 已停止");
    }
  } finally {
    database.close();
  }
}

function isGatewayRunning(environment) {
  if (
    environment.CODEX_CONNECT_SERVICE_ROLE === "gateway"
    || environment.CODEX_CONNECT_GATEWAY_SUPERVISED === "1"
  ) {
    return true;
  }
  if (process.platform === "linux") {
    const result = spawnSync(
      environment.SYSTEMCTL_BINARY || "systemctl",
      ["--user", "show", "--property=ActiveState", "--value", "codex-connect-gateway.service"],
      { encoding: "utf8", env: environment },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error("无法确认 Gateway 服务状态；为保护指标数据库，已拒绝重置");
    }
    const state = result.stdout.trim();
    return state !== "inactive";
  }
  if (process.platform === "darwin") {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const result = spawnSync(
      environment.LAUNCHCTL_BINARY || "launchctl",
      ["print", `gui/${uid}/com.hegenai.codex-gateway`],
      { stdio: "ignore", env: environment },
    );
    if (result.error) throw result.error;
    return result.status === 0;
  }
  return false;
}

function metricsSocketIsActive(socketPath) {
  if (!existsSync(socketPath)) return false;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { createConnection } from "node:net";
const socket = createConnection(process.argv[1]);
let settled = false;
const finish = (code) => {
  if (settled) return;
  settled = true;
  socket.destroy();
  process.exitCode = code;
};
socket.once("connect", () => finish(0));
socket.once("error", () => finish(1));
socket.setTimeout(500, () => finish(2));`,
      socketPath,
    ],
    { stdio: "ignore", timeout: 1_000 },
  );
  if (result.error) {
    throw new Error("无法确认 Gateway 指标 Socket 状态；为保护指标数据库，已拒绝重置");
  }
  return result.status !== 1;
}

function backupTimestamp(date) {
  return date.toISOString().replaceAll(/[:.]/gu, "-");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function printStatus(result) {
  console.log(`指标数据库：${result.databasePath}`);
  if (!result.exists) {
    console.log("状态：尚未创建");
    return;
  }
  console.log(`Schema：${result.schemaVersion ?? "无法识别"}`);
  console.log(`兼容：${result.compatible ? "是" : "否"}`);
  console.log(`记录：${result.count ?? "无法读取"}`);
  if (!result.compatible) {
    console.log("处理：停止 Gateway 后运行 codexc metrics reset");
  }
}

function printMetricsReport(result) {
  const aggregate = result.report.aggregate;
  console.log("# Codex Connect 请求指标报告");
  console.log("");
  console.log(`- 生成时间：${result.generatedAt}`);
  console.log(`- 时间范围：${result.range.name}`);
  console.log(`- 起始时间：${new Date(result.range.startAtMs).toISOString()}`);
  console.log(`- 截止时间：${new Date(result.range.endAtMs).toISOString()}`);
  console.log("");
  console.log("## 汇总");
  console.log("");
  if (!aggregate) {
    console.log("本时间范围没有请求记录。");
    return;
  }
  console.log(`- 模型请求：${aggregate.requestCount}`);
  console.log(`- 异常或未完整观测：${aggregate.unsuccessfulRequestCount}`);
  console.log(`- 输入 Token：${aggregate.inputTokens}`);
  console.log(`- 缓存输入 Token：${aggregate.cachedInputTokens ?? "未知"}`);
  console.log(`- 输出 Token：${aggregate.outputTokens}`);
  console.log(`- 推理输出 Token：${aggregate.reasoningOutputTokens}`);
  console.log(`- 计价覆盖：${aggregate.pricedRequestCount}/${aggregate.requestCount}`);
  console.log(`- 参考总价：${formatCost(aggregate)}`);
  console.log(`- 首段延迟 P50/P95：${formatDuration(aggregate.ttftP50Ms)}/${formatDuration(aggregate.ttftP95Ms)}`);
  if (result.report.groups.length > 0) {
    console.log("");
    console.log("## 明细");
    console.log("");
    console.log("| 提供商 | 模型 | 请求 | 异常/未完整 | 输入 | 缓存输入 | 输出 | 参考总价 |");
    console.log("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const group of result.report.groups) {
      const value = group.aggregate;
      console.log(`| ${markdownCell(group.provider ?? "全部")} | ${markdownCell(group.model ?? "全部/未观测")} | ${value.requestCount} | ${value.unsuccessfulRequestCount} | ${value.inputTokens} | ${value.cachedInputTokens ?? "未知"} | ${value.outputTokens} | ${formatCost(value)} |`);
    }
    const hidden = result.report.totalGroupCount - result.report.groups.length;
    if (hidden > 0) console.log(`\n仅显示请求量最高的 ${result.report.groups.length} 组，另有 ${hidden} 组。`);
  }
  console.log("");
  console.log("## 异常与未完整观测");
  console.log("");
  if (result.errors.groups.length === 0) {
    console.log("本时间范围没有异常或未完整观测请求。");
    return;
  }
  console.log("| 提供商 | 模型 | 状态 | 类型 | HTTP | 次数 |");
  console.log("| --- | --- | --- | --- | ---: | ---: |");
  for (const group of result.errors.groups) {
    console.log(`| ${markdownCell(group.provider)} | ${markdownCell(group.model ?? "未观测")} | ${group.status} | ${markdownCell(group.errorType ?? "未提供")} | ${group.httpStatus ?? ""} | ${group.requestCount} |`);
  }
}

function printMetricsExport(result, format) {
  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const columns = csvColumns();
  console.log(columns.map(([heading]) => csvCell(heading)).join(","));
  for (const record of result.records) {
    console.log(columns.map(([, read]) => csvCell(read(record))).join(","));
  }
}

function metricsRange(name, nowMs) {
  const duration = {
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
  }[name];
  if (duration === undefined) throw new Error("--range 只支持 24h、7d 或 30d");
  return { name, startAtMs: Math.max(0, nowMs - duration), endAtMs: nowMs };
}

function metricsDimension(value) {
  const result = { global: "global", providers: "provider", models: "model" }[value];
  if (!result) throw new Error("--group 只支持 global、providers 或 models");
  return result;
}

function parseMetricsOptions(args, allowed) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option)) throw new Error(`未知参数：${option}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} 缺少值`);
    result[option.slice(2)] = value;
    index += 1;
  }
  return result;
}

function formatCost(aggregate) {
  if (aggregate.totalCostNanos === null || aggregate.pricingCurrency === null) return "未知";
  const amount = (aggregate.totalCostNanos / 1_000_000_000).toFixed(2);
  return aggregate.pricingCurrency === "USD" ? `$${amount}` : `${amount} ${aggregate.pricingCurrency}`;
}

function formatDuration(value) {
  return value === null ? "未知" : `${Math.round(value)}ms`;
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvColumns() {
  return [
    ["id", (record) => record.id],
    ["recordedAt", (record) => new Date(record.recordedAtMs).toISOString()],
    ["provider", (record) => record.provider],
    ["model", (record) => record.model],
    ["serviceTier", (record) => record.serviceTier],
    ["status", (record) => record.status],
    ["errorType", (record) => record.errorType],
    ["incompleteReason", (record) => record.incompleteReason],
    ["httpStatus", (record) => record.httpStatus],
    ["transport", (record) => record.transport],
    ["responseFormat", (record) => record.responseFormat],
    ["operation", (record) => record.operation],
    ["threadId", (record) => record.threadId],
    ["turnId", (record) => record.turnId],
    ["requestDurationMs", (record) => record.requestDurationMs],
    ["ttftMs", (record) => record.ttftMs],
    ["inputTokens", (record) => record.inputTokens],
    ["cachedInputTokens", (record) => record.cachedInputTokens],
    ["uncachedInputTokens", (record) => record.uncachedInputTokens],
    ["outputTokens", (record) => record.outputTokens],
    ["reasoningOutputTokens", (record) => record.reasoningOutputTokens],
    ["outputTokensPerSecond", (record) => record.outputTokensPerSecond],
    ["pricingCurrency", (record) => record.pricing?.currency],
    ["uncachedInputPricePerMillionNanos", (record) => record.pricing?.uncachedInputPricePerMillionNanos],
    ["cachedInputPricePerMillionNanos", (record) => record.pricing?.cachedInputPricePerMillionNanos],
    ["outputPricePerMillionNanos", (record) => record.pricing?.outputPricePerMillionNanos],
    ["totalCostNanos", (record) => record.totalCostNanos],
  ];
}

if (
  process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const command = process.argv[2];
    if (command === "status" && process.argv.length === 3) {
      printStatus(inspectMetricsDatabase());
    } else if (command === "reset" && process.argv.length === 3) {
      const result = resetMetricsDatabase();
      if (!result.changed) {
        console.log(`指标数据库尚未创建：${result.databasePath}`);
      } else {
        console.log(`指标数据库已归档并重置：${result.databasePath}`);
        console.log(`旧库备份：${result.backupPath}`);
        console.log("启动 Gateway 后将自动创建当前 Schema。");
      }
    } else if (command === "report") {
      const options = parseMetricsOptions(
        process.argv.slice(3),
        new Set(["--range", "--group"]),
      );
      printMetricsReport(readMetricsReport(process.env, options));
    } else if (command === "export") {
      const options = parseMetricsOptions(
        process.argv.slice(3),
        new Set(["--range", "--format"]),
      );
      const format = options.format ?? "json";
      if (format !== "json" && format !== "csv") {
        throw new Error("--format 只支持 json 或 csv");
      }
      printMetricsExport(readMetricsExport(process.env, options), format);
    } else {
      throw new Error("用法：codexc metrics <status|reset|report|export>");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
