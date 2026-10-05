/**
 * WebUI 的模型调用记录只读接口：列出逻辑模型调用摘要与单条请求/终态响应。
 *
 * 调用记录包含原始 prompt、代码与工具输出，因此这里只接受回环连接，且只按标签读取
 * 数据目录下 `traffic/` 的 V2 session，不接受任意路径。
 */
import { join } from "node:path";

import {
  readGatewayConfig,
  validateDebugConfigDocument,
} from "../runtime/gateway-config.mjs";
import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import {
  TrafficDumpDebugError,
  describeDumpExchange,
  describeDumpTrace,
  dumpCatalog,
  selectFilesOfLabel,
  summarizeDumpFiles,
  writerSessionOf,
} from "./traffic-dump-reader.mjs";
import { ApiError, isLoopbackAddress, sendJson } from "./webui-http.mjs";
import { openQueueStream } from "./webui-queue-events.mjs";
import { watchTrafficChanges } from "./webui-traffic-events.mjs";

const defaultPageSize = 100;
const maximumPageSize = 500;
const maximumPageOffset = 50_000;
/** 单段正文回传上限；浏览器可承受该体量，超出时响应里带截断标记。 */
const maximumSectionBytes = 4 * 1_048_576;
/** Trace 页同时受正文总量和记录数约束，避免大量空记录绕过字节上限。 */
const maximumTracePageSize = 100;

export function routeTrafficEvents({ environment, request, response, url, state }) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(503, "traffic_unavailable", "调用记录查看只允许回环访问");
  }
  assertParameters(url, ["label", "session", "detail"]);
  const scope = {};
  for (const name of ["label", "session"]) {
    const values = url.searchParams.getAll(name);
    // Custom Provider IDs may start with '_' or '-'; keep their saved dump labels subscribable.
    const pattern = name === "label" ? /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/u : /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
    if (values.length > 1 || (values.length === 1 && !pattern.test(values[0]))) {
      throw new ApiError(400, "invalid_parameter", "调用通知范围无效");
    }
    if (values.length) scope[name] = values[0];
  }
  const detail = url.searchParams.getAll("detail");
  if (detail.length > 1 || (detail.length === 1 && detail[0] !== "1")) {
    throw new ApiError(400, "invalid_parameter", "调用通知范围无效");
  }
  scope.detail = detail.length === 1;
  const located = locateOptionalUserConfig(environment);
  const directory = join(located?.dataDir ?? userDataDir(environment), "traffic");
  openQueueStream(state, response, (signal, send) => watchTrafficChanges(directory, scope, signal, send));
}

export async function routeTrafficApi({ apiPath, environment, request, response, url }) {
  if (!["/traffic", "/traffic/exchange", "/traffic/trace"].includes(apiPath)) return false;
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(503, "traffic_unavailable", "调用记录查看只允许回环访问");
  }
  const located = locateOptionalUserConfig(environment);
  const directory = join(located?.dataDir ?? userDataDir(environment), "traffic");
  let catalog;
  try {
    catalog = dumpCatalog(directory);
  } catch (error) {
    throw new ApiError(
      503,
      "traffic_unsupported_version",
      error instanceof Error ? error.message : "模型调用记录版本无效",
    );
  }
  const labels = catalog.labels;
  if (apiPath !== "/traffic" && url.searchParams.has("session") && labels.length === 0) {
    throw new ApiError(404, "traffic_session_not_found", "关联调用记录不可用：批次尚未写入、写入失败或已被清理；不会匹配其他请求");
  }
  if (labels.length === 0) {
    throw new ApiError(
      503,
      "traffic_unavailable",
      "还没有调用记录文件：Codex 与 Relay 共用 [debug].model_traffic_dump，请开启全局“记录调用详情”",
    );
  }
  const dump = dumpSettings(environment);
  if (apiPath === "/traffic") {
    assertParameters(url, ["label", "limit", "offset", "session"]);
    const label = url.searchParams.has("label") ? readLabel(url, labels) : null;
    const { files, session } = readSessionFiles(url, catalog.files, label);
    const page = await summarizeDumpFiles(files, {
      newestFirst: true,
      limit: readInteger(url, "limit", defaultPageSize, 1, maximumPageSize),
      offset: readInteger(url, "offset", 0, 0, maximumPageOffset),
    });
    sendJson(response, 200, {
      directory,
      enabled: dump.enabled,
      retentionDays: dump.retentionDays,
      generatedAt: new Date().toISOString(),
      label,
      labels,
      maximumOffset: maximumPageOffset,
      session,
      sessions: catalog.sessions.filter((entry) => label === null || entry.label === label)
        .map(({ session, createdAtMs }) => ({ session, createdAtMs })).reverse(),
      ...page,
      nextOffset: page.nextOffset !== null && page.nextOffset <= maximumPageOffset
        ? page.nextOffset
        : null,
    });
    return true;
  }
  assertParameters(url, ["id", "label", "session", "traceOffset"]);
  const label = readLabel(url, labels);
  const id = readInteger(url, "id", undefined, 1, Number.MAX_SAFE_INTEGER);
  const traceOffset = readInteger(
    url,
    "traceOffset",
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const { files } = readSessionFiles(url, catalog.files, label);
  if (files.length !== 1) {
    throw new ApiError(400, "missing_parameter", "查看模型调用明细需指定 session");
  }
  const session = writerSessionOf(files[0]);
  const describe = apiPath === "/traffic/trace" ? describeDumpTrace : describeDumpExchange;
  const exchange = await describe(files, id, {
    traceOffset,
    maxTracePageSize: maximumTracePageSize,
    maxSectionBytes: maximumSectionBytes,
  }).catch(error => {
    if (error instanceof TrafficDumpDebugError) throw new ApiError(503, error.code, error.message);
    throw error;
  });
  if (exchange === null) {
    throw new ApiError(404, "traffic_exchange_not_found", `没有找到关联模型调用 #${id}：记录可能尚未写入、写入失败或已被清理；不会匹配其他请求`);
  }
  if (traceOffset > 0 && traceOffset >= exchange.tracePage.total) {
    throw new ApiError(400, "invalid_parameter", "traceOffset 超出允许范围");
  }
  sendJson(response, 200, {
    directory,
    enabled: dump.enabled,
    retentionDays: dump.retentionDays,
    exchange,
    generatedAt: new Date().toISOString(),
    label,
    session,
  });
  return true;
}

function dumpSettings(environment) {
  const explicitConfigFile = environment.CODEX_CONNECT_CONFIG_FILE?.trim();
  const configPath = explicitConfigFile
    ? explicitConfigFile
    : join(userDataDir(environment), "config.toml");
  try {
    const document = readGatewayConfig(configPath);
    const debug = validateDebugConfigDocument(document.debug ?? {});
    return {
      enabled: debug.model_traffic_dump,
      retentionDays: debug.model_traffic_retention_days,
    };
  } catch {
    return { enabled: false, retentionDays: 30 };
  }
}

function assertParameters(url, allowed) {
  const names = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!names.has(key)) {
      throw new ApiError(400, "unsupported_parameter", `不支持的查询参数：${key}`);
    }
  }
}

function readLabel(url, labels) {
  const values = url.searchParams.getAll("label");
  if (values.length > 1) {
    throw new ApiError(400, "unsupported_parameter", "label 只能出现一次");
  }
  if (values.length === 0) return labels[0].label;
  const label = values[0];
  if (!labels.some((entry) => entry.label === label)) {
    throw new ApiError(404, "traffic_label_not_found", `没有该标签的调用记录文件：${label}；关联记录可能尚未写入、写入失败或已被清理`);
  }
  return label;
}

function readSessionFiles(url, catalogFiles, label) {
  const values = url.searchParams.getAll("session");
  if (values.length > 1) {
    throw new ApiError(400, "unsupported_parameter", "session 只能出现一次");
  }
  const requested = values[0];
  const files = label === null
    ? catalogFiles.filter((file) => requested === undefined || writerSessionOf(file) === requested)
    : selectFilesOfLabel(catalogFiles, label, requested);
  if (files.length === 0) {
    throw new ApiError(
      404,
      "traffic_session_not_found",
      `没有该标签的 writer session：${requested}；关联记录可能尚未写入、写入失败或已被清理，不会匹配其他批次`,
    );
  }
  return { files, session: requested ?? null };
}

function readInteger(url, name, fallback, minimum, maximum) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new ApiError(400, "unsupported_parameter", `${name} 只能出现一次`);
  }
  if (values.length === 0) {
    if (fallback === undefined) {
      throw new ApiError(400, "missing_parameter", `缺少查询参数：${name}`);
    }
    return fallback;
  }
  const raw = values[0];
  if (!/^[0-9]+$/u.test(raw)) {
    throw new ApiError(400, "invalid_parameter", `${name} 需要非负整数`);
  }
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new ApiError(400, "invalid_parameter", `${name} 超出允许范围`);
  }
  return value;
}
