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
  describeDumpExchange,
  describeDumpTrace,
  describeDumpTurnStates,
  dumpCatalog,
  readDumpResponseProviders,
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

/** 指标记录与调用记录共用的关联键；引用缺失或形态无效时返回 null，不猜测其他批次。 */
export function dumpReferenceKey(reference) {
  if (reference === null || reference === undefined) return null;
  const { label, session, interaction } = reference;
  if (typeof label !== "string" || label === "" || typeof session !== "string" || session === ""
    || !Number.isSafeInteger(interaction) || interaction <= 0) {
    return null;
  }
  return `${label}\u0000${session}\u0000${interaction}`;
}

/**
 * 请求明细列表按需关联调用记录里的 Chat 上游提供商：只读本页出现的批次索引，
 * 调用记录缺失、格式不支持或读取失败时返回空表，既不阻断指标展示，也不回填历史。
 */
export async function readDumpUpstreamProviders(environment, references) {
  const providers = new Map();
  const groups = new Map();
  for (const reference of references) {
    if (dumpReferenceKey(reference) === null) continue;
    const key = `${reference.label}\u0000${reference.session}`;
    if (!groups.has(key)) groups.set(key, { label: reference.label, session: reference.session, ids: new Set() });
    groups.get(key).ids.add(reference.interaction);
  }
  if (groups.size === 0) return providers;
  const located = locateOptionalUserConfig(environment);
  const directory = join(located?.dataDir ?? userDataDir(environment), "traffic");
  let catalog;
  try {
    catalog = dumpCatalog(directory);
  } catch {
    return providers;
  }
  for (const group of groups.values()) {
    const files = selectFilesOfLabel(catalog.files, group.label, group.session);
    if (files.length === 0) continue;
    let selected;
    try {
      selected = await readDumpResponseProviders(files, group.ids);
    } catch {
      continue;
    }
    for (const [interaction, provider] of selected) {
      const key = dumpReferenceKey({ label: group.label, session: group.session, interaction });
      if (key !== null) providers.set(key, provider);
    }
  }
  return providers;
}

export async function routeTrafficApi({ apiPath, environment, request, response, url }) {
  if (!["/traffic", "/traffic/exchange", "/traffic/trace", "/traffic/turn-state"].includes(apiPath)) return false;
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
    if (catalog.legacyFiles.length > 0) {
      throw new ApiError(
        503,
        "traffic_legacy_format",
        "现有调用记录是旧版逐帧格式；请重启 App Server 生成 V2 调用记录，旧文件不会自动迁移",
      );
    }
    throw new ApiError(
      503,
      "traffic_unavailable",
      "还没有调用记录文件：在 config.toml 的 [debug] 开启 model_traffic_dump 后重启 App Server 服务",
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
  if (apiPath === "/traffic/turn-state") {
    assertParameters(url, ["ids", "label", "session"]);
    if (!url.searchParams.has("label") || !url.searchParams.has("session")) {
      throw new ApiError(400, "missing_parameter", "读取字符数需指定 label 和 session");
    }
    const values = url.searchParams.getAll("ids");
    const ids = values.length === 1 && /^[1-9][0-9]*(,[1-9][0-9]*)*$/u.test(values[0])
      ? values[0].split(",").map(Number) : [];
    if (ids.length === 0 || ids.length > maximumPageSize || ids.some((id) => !Number.isSafeInteger(id))
      || new Set(ids).size !== ids.length) {
      throw new ApiError(400, "invalid_parameter", "ids 必须是当前页不重复的有效调用编号");
    }
    const label = readLabel(url, labels);
    const { files } = readSessionFiles(url, catalog.files, label);
    if (files.length !== 1) throw new ApiError(400, "invalid_parameter", "字符数查询必须定位唯一批次");
    const exchanges = await describeDumpTurnStates(files, ids);
    if (exchanges === null) throw new ApiError(404, "traffic_exchange_not_found", "关联调用记录不可用；不会匹配其他请求");
    sendJson(response, 200, { label, session: writerSessionOf(files[0]), exchanges });
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
