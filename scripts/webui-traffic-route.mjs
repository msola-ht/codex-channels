/**
 * WebUI 的模型转储只读接口：列出逻辑模型调用摘要与单条请求/终态响应。
 *
 * 转储包含原始 prompt、代码与工具输出，因此这里只接受回环连接，且只按标签读取
 * 数据目录下 `traffic/` 的 V2 session，不接受任意路径。
 */
import { join } from "node:path";

import {
  readGatewayConfig,
  validateDebugConfigDocument,
} from "../runtime/gateway-config.mjs";
import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import {
  describeDumpExchange,
  dumpCatalog,
  selectFilesOfLabel,
  summarizeDumpFiles,
  writerSessionOf,
} from "./traffic-dump-reader.mjs";
import { ApiError, isLoopbackAddress, sendJson } from "./webui-http.mjs";

const defaultPageSize = 100;
const maximumPageSize = 500;
const maximumPageOffset = 50_000;
/** 单段正文回传上限；浏览器可承受该体量，超出时响应里带截断标记。 */
const maximumSectionBytes = 4 * 1_048_576;
/** Trace 页同时受正文总量和记录数约束，避免大量空记录绕过字节上限。 */
const maximumTracePageSize = 100;

export async function routeTrafficApi({ apiPath, environment, request, response, url }) {
  if (apiPath !== "/traffic" && apiPath !== "/traffic/exchange") return false;
  if (!isLoopbackAddress(request.socket.remoteAddress)) {
    throw new ApiError(503, "traffic_unavailable", "转储查看只允许回环访问");
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
      error instanceof Error ? error.message : "模型流量转储版本无效",
    );
  }
  const labels = catalog.labels;
  if (labels.length === 0) {
    if (catalog.legacyFiles.length > 0) {
      throw new ApiError(
        503,
        "traffic_legacy_format",
        "现有转储是旧版逐帧格式；请重启 App Server 生成 V2 转储，旧文件不会自动迁移",
      );
    }
    throw new ApiError(
      503,
      "traffic_unavailable",
      "还没有转储文件：在 config.toml 的 [debug] 开启 model_traffic_dump 后重启 App Server 服务",
    );
  }
  const dump = dumpSettings(environment);
  if (apiPath === "/traffic") {
    assertParameters(url, ["label", "limit", "offset", "session"]);
    const label = readLabel(url, labels);
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
      sessions: catalog.sessions.filter((entry) => entry.label === label)
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
  const exchange = await describeDumpExchange(files, id, {
    traceOffset,
    maxTracePageSize: maximumTracePageSize,
    maxSectionBytes: maximumSectionBytes,
  });
  if (exchange === null) {
    throw new ApiError(404, "traffic_exchange_not_found", `没有找到模型调用 #${id}`);
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
    const debug = validateDebugConfigDocument(readGatewayConfig(configPath).debug ?? {});
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
    throw new ApiError(404, "traffic_label_not_found", `没有该标签的转储文件：${label}`);
  }
  return label;
}

function readSessionFiles(url, catalogFiles, label) {
  const values = url.searchParams.getAll("session");
  if (values.length > 1) {
    throw new ApiError(400, "unsupported_parameter", "session 只能出现一次");
  }
  const requested = values[0];
  const files = selectFilesOfLabel(catalogFiles, label, requested);
  if (files.length === 0) {
    throw new ApiError(
      404,
      "traffic_session_not_found",
      `没有该标签的 writer session：${requested}`,
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
