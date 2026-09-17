/**
 * 模型报文转储的共享解析模块：`codexc traffic` 与 WebUI 转储页共用同一套文件选择、
 * 记录解析、exchange 归组与字段提取，避免出现两套解析口径。
 *
 * 列表汇总按行流式处理且只保留摘要字段，详情只保留目标 exchange 的记录，
 * 因此单次请求的内存占用不随转储文件大小增长。
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

export function listDumpFiles(directory) {
  try {
    return readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(directory, name))
      .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
  } catch {
    return [];
  }
}

export function labelOf(path) {
  return basename(path).split("-")[0];
}

/** 标签列表按最新文件时间倒序排列，供选择要查看的 Provider。 */
export function dumpLabels(directory) {
  const byLabel = new Map();
  for (const path of listDumpFiles(directory)) {
    const label = labelOf(path);
    const entry = byLabel.get(label) ?? { files: 0, label, latestAtMs: 0 };
    entry.files += 1;
    entry.latestAtMs = Math.max(entry.latestAtMs, statSync(path).mtimeMs);
    byLabel.set(label, entry);
  }
  return [...byLabel.values()].sort((left, right) => right.latestAtMs - left.latestAtMs);
}

/**
 * 同一标签的最新两个文件：轮转可能把同一次 exchange 的记录切到两个文件，
 * 单个文件不足以还原完整报文。
 */
export function filesOfLabel(directory, label) {
  return listDumpFiles(directory)
    .filter((path) => labelOf(path) === label)
    .slice(-2);
}

/** 逐行流式读取转储文件；单行解析失败时跳过，不中断其余记录。 */
export async function forEachDumpRecord(files, visit) {
  for (const file of files) {
    const input = createReadStream(file, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (line.length === 0) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        visit(record);
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
}

export function groupExchanges(records) {
  const byId = new Map();
  for (const record of records) {
    let exchange = byId.get(record.exchange);
    if (exchange === undefined) {
      exchange = {
        account: record.account,
        id: record.exchange,
        records: [],
        startedAtMs: record.startedAtMs,
      };
      byId.set(record.exchange, exchange);
    }
    exchange.records.push(record);
  }
  return [...byId.values()];
}

export function findRecord(exchange, kind) {
  return exchange.records.find((record) => record.kind === kind);
}

export function recordsOfKind(exchange, kind) {
  return exchange.records.filter((record) => record.kind === kind);
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function parseTurnMetadata(value) {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (typeof parsed !== "object" || parsed === null) return {};
  return {
    requestKind: typeof parsed.request_kind === "string" ? parsed.request_kind : undefined,
    threadId: typeof parsed.thread_id === "string" ? parsed.thread_id : undefined,
    turnId: typeof parsed.turn_id === "string" && parsed.turn_id.length > 0
      ? parsed.turn_id
      : undefined,
  };
}

/** 请求侧模型名：HTTP 请求体与 WebSocket 客户端帧都放在顶层 `model`。 */
export function requestModelOfText(text) {
  const model = parseJson(text)?.model;
  return typeof model === "string" ? model : undefined;
}

/** 响应侧模型名：SSE 事件与 WebSocket 上游帧都放在 `response.model` 或顶层 `model`。 */
export function responseModelsOfPayload(payload) {
  const model = payload?.response?.model ?? payload?.model;
  return typeof model === "string" ? [model] : [];
}

export function requestMetadata(exchange) {
  const head = findRecord(exchange, "request_head");
  if (head !== undefined) return parseTurnMetadata(head.headers?.["x-codex-turn-metadata"]);
  for (const frame of websocketFrames(exchange)) {
    if (frame.direction !== "client") continue;
    const parsed = parseJson(String(frame.text ?? ""));
    const metadata = parseTurnMetadata(parsed?.client_metadata?.["x-codex-turn-metadata"]);
    if (metadata.threadId !== undefined) return metadata;
    const threadId = parsed?.client_metadata?.thread_id;
    if (typeof threadId === "string") return { threadId };
  }
  return {};
}

/**
 * 单帧超过转储上限时会被切分为多条 `part` 记录，这里按方向和连续序号还原成完整帧；
 * 二进制帧只保留长度占位，不参与 JSON 解析。
 */
export function websocketFrames(exchange) {
  const frames = [];
  for (const record of recordsOfKind(exchange, "websocket_frame")) {
    const last = frames.at(-1);
    if (last !== undefined && last.direction === record.direction && record.part === last.part + 1) {
      last.part = record.part;
      last.text += frameText(record);
      continue;
    }
    frames.push({ direction: record.direction, part: record.part, text: frameText(record) });
  }
  return frames;
}

export function frameText(record) {
  return typeof record.text === "string"
    ? record.text
    : `<二进制帧 ${record.bytes ?? 0} 字节>`;
}

export function joinBodies(exchange, kind) {
  return recordsOfKind(exchange, kind)
    .sort((left, right) => left.part - right.part)
    .map((record) => (typeof record.text === "string"
      ? record.text
      : `<${record.encoding ?? "binary"} ${record.bytes ?? 0} 字节>`))
    .join("");
}

export function requestModelOf(exchange) {
  const body = joinBodies(exchange, "request_body");
  const fromBody = body.length > 0 ? requestModelOfText(body) : undefined;
  if (fromBody !== undefined) return fromBody;
  for (const frame of websocketFrames(exchange)) {
    if (frame.direction !== "client") continue;
    const model = requestModelOfText(String(frame.text ?? ""));
    if (model !== undefined) return model;
  }
  return undefined;
}

export function responseModelsOf(exchange) {
  return [...new Set(responsePayloads(exchange).flatMap(responseModelsOfPayload))];
}

export function responsePayloads(exchange) {
  const payloads = [];
  for (const event of parseSseEvents(joinBodies(exchange, "response_body"))) {
    if (event.parsed !== undefined) payloads.push(event.parsed);
  }
  for (const frame of websocketFrames(exchange)) {
    if (frame.direction !== "upstream") continue;
    const parsed = parseJson(String(frame.text ?? ""));
    if (parsed !== undefined) payloads.push(parsed);
  }
  return payloads;
}

export function parseSseEvents(text) {
  const events = [];
  for (const block of text.split("\n\n")) {
    let type;
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    const raw = dataLines.join("\n");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    events.push({
      parsed,
      raw,
      type: type ?? (typeof parsed?.type === "string" ? parsed.type : "data"),
    });
  }
  return events;
}

export function shortId(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8) : "-";
}

export function formatTime(atMs) {
  if (typeof atMs !== "number") return "-";
  const date = new Date(atMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 从一条记录更新列表摘要；只保留摘要字段，正文用完即弃。 */
export function applyRecordToSummary(summary, record) {
  switch (record.kind) {
    case "request_head": {
      const metadata = parseTurnMetadata(record.headers?.["x-codex-turn-metadata"]);
      summary.requestKind = metadata.requestKind;
      summary.threadId = metadata.threadId;
      summary.turnId = metadata.turnId;
      summary.method = record.method;
      summary.path = record.path;
      summary.transport = "http";
      break;
    }
    case "websocket_handshake":
      summary.transport = "websocket";
      summary.url = record.url;
      break;
    case "websocket_frame": {
      summary.transport = "websocket";
      const parsed = parseJson(String(record.text ?? ""));
      if (record.direction === "client") {
        if (summary.requestModel === undefined) {
          const model = requestModelOfText(String(record.text ?? ""));
          if (model !== undefined) summary.requestModel = model;
        }
        if (summary.threadId === undefined) {
          const metadata = parseTurnMetadata(parsed?.client_metadata?.["x-codex-turn-metadata"]);
          const threadId = metadata.threadId
            ?? (typeof parsed?.client_metadata?.thread_id === "string"
              ? parsed.client_metadata.thread_id
              : undefined);
          if (threadId !== undefined) summary.threadId = threadId;
        }
        break;
      }
      if (parsed !== undefined) {
        for (const model of responseModelsOfPayload(parsed)) summary.responseModels.add(model);
      }
      break;
    }
    case "request_body":
      if (summary.requestModel === undefined) {
        const model = requestModelOfText(record.text ?? "");
        if (model !== undefined) summary.requestModel = model;
      }
      break;
    case "response_head":
      // 请求头记录可能落在已被清理的旧文件里，响应头同样能证明这是 HTTP 交换。
      if (summary.transport === undefined) summary.transport = "http";
      summary.status = record.status;
      break;
    case "response_body":
      for (const event of parseSseEvents(record.text ?? "")) {
        if (event.parsed === undefined) continue;
        for (const model of responseModelsOfPayload(event.parsed)) summary.responseModels.add(model);
      }
      break;
    case "error":
      summary.hasError = true;
      break;
    default:
      break;
  }
}

export function emptySummary(record) {
  return {
    account: record.account,
    hasError: false,
    id: record.exchange,
    method: undefined,
    path: undefined,
    requestKind: undefined,
    requestModel: undefined,
    responseModels: new Set(),
    startedAtMs: record.startedAtMs,
    status: undefined,
    threadId: undefined,
    transport: undefined,
    turnId: undefined,
    url: undefined,
  };
}

/** 列表数据：按行流式汇总后排序分页，响应里不包含任何正文。 */
export async function summarizeDumpFiles(files, { limit, offset = 0 } = {}) {
  const entries = new Map();
  await forEachDumpRecord(files, (record) => {
    let summary = entries.get(record.exchange);
    if (summary === undefined) {
      summary = emptySummary(record);
      entries.set(record.exchange, summary);
    }
    applyRecordToSummary(summary, record);
  });
  const all = [...entries.values()]
    .sort((left, right) => (left.startedAtMs ?? 0) - (right.startedAtMs ?? 0) || left.id - right.id)
    .map((summary) => ({ ...summary, responseModels: [...summary.responseModels] }));
  const start = Math.min(Math.max(offset, 0), all.length);
  const end = limit === undefined ? all.length : Math.min(start + limit, all.length);
  return {
    exchanges: all.slice(start, end),
    nextOffset: end < all.length ? end : null,
    total: all.length,
  };
}

/** 详情：只保留目标 exchange 的记录，再按组提取结构化字段。 */
export async function describeDumpExchange(files, id, { maxSectionBytes = 262_144 } = {}) {
  const selected = [];
  await forEachDumpRecord(files, (record) => {
    if (record.exchange === id) selected.push(record);
  });
  if (selected.length === 0) return null;
  return exchangeDetail(groupExchanges(selected)[0], maxSectionBytes);
}

export function exchangeDetail(exchange, maxSectionBytes = 262_144) {
  const head = findRecord(exchange, "request_head");
  const handshake = findRecord(exchange, "websocket_handshake");
  const responseHead = findRecord(exchange, "response_head");
  const metadata = requestMetadata(exchange);
  const requestBody = boundedText(joinBodies(exchange, "request_body"), maxSectionBytes);
  const responseBody = boundedText(joinBodies(exchange, "response_body"), maxSectionBytes);
  return {
    account: exchange.account,
    closes: recordsOfKind(exchange, "websocket_close").map((record) => ({
      code: record.code,
      peer: record.peer,
      reason: record.reason,
    })),
    errors: recordsOfKind(exchange, "error").map((record) => ({
      message: record.message,
      scope: record.scope,
    })),
    events: parseSseEvents(joinBodies(exchange, "response_body")).map((event) => ({
      payload: event.parsed === undefined ? event.raw : JSON.stringify(event.parsed, null, 2),
      type: event.type,
    })),
    frames: websocketFrames(exchange).map((frame) => {
      const bounded = boundedText(frame.text, maxSectionBytes);
      return { direction: frame.direction, text: bounded.text, truncated: bounded.truncated };
    }),
    id: exchange.id,
    request: head === undefined
      ? null
      : {
          body: requestBody.text,
          bodyTruncated: requestBody.truncated,
          bytes: findRecord(exchange, "request_end")?.bytes,
          headers: head.headers ?? {},
          method: head.method,
          path: head.path,
        },
    requestKind: metadata.requestKind,
    requestModel: requestModelOf(exchange),
    response: responseHead === undefined
      ? null
      : {
          body: responseBody.text,
          bodyTruncated: responseBody.truncated,
          bytes: findRecord(exchange, "response_end")?.bytes,
          durationMs: findRecord(exchange, "response_end")?.durationMs,
          headers: responseHead.headers ?? {},
          status: responseHead.status,
        },
    responseModels: responseModelsOf(exchange),
    startedAtMs: exchange.startedAtMs,
    threadId: metadata.threadId,
    transport: transportOf(exchange),
    turnId: metadata.turnId,
    url: handshake?.url,
    websocketHeaders: handshake?.headers ?? null,
  };
}

const httpRecordKinds = [
  "request_head",
  "request_body",
  "request_end",
  "response_head",
  "response_body",
  "response_end",
];
const websocketRecordKinds = ["websocket_close", "websocket_frame", "websocket_handshake"];

/**
 * 请求头记录可能被轮转清理，因此按可用记录判断传输类型：先看 WebSocket 记录，再看 HTTP 记录，
 * 两者都没有时不猜。
 */
function transportOf(exchange) {
  const kinds = new Set(exchange.records.map((record) => record.kind));
  if (websocketRecordKinds.some((kind) => kinds.has(kind))) return "websocket";
  if (httpRecordKinds.some((kind) => kinds.has(kind))) return "http";
  return undefined;
}

function boundedText(text, maxBytes) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };
  return {
    text: `${Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8")}\n…（共 ${bytes} 字节，已截断）`,
    truncated: true,
  };
}
