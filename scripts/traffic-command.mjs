#!/usr/bin/env node

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { locateOptionalUserConfig, userDataDir } from "./runtime-config.mjs";
import { parseTrafficCommandArgs } from "./traffic-command-options.mjs";

const followIntervalMs = 1_000;

const options = parseTrafficCommandArgs(process.argv.slice(2));
const directory = options.directory ?? defaultTrafficDirectory();

function defaultTrafficDirectory() {
  const located = locateOptionalUserConfig(process.env);
  return join(located?.dataDir ?? userDataDir(process.env), "traffic");
}

if (options.follow) {
  await followTraffic();
} else {
  renderFiles(selectedFiles(), options);
}

function selectedFiles() {
  if (options.files.length > 0) return options.files;
  return newestDumpFiles(directory);
}

function listDumpFiles(target = directory) {
  try {
    return readdirSync(target)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(target, name))
      .sort((left, right) => statSync(left).mtimeMs - statSync(right).mtimeMs);
  } catch {
    return [];
  }
}

function newestDumpFiles(target) {
  const files = listDumpFiles(target);
  const newest = files.at(-1);
  if (newest === undefined) return [];
  const label = labelOf(newest);
  return files.filter((path) => labelOf(path) === label).slice(-2);
}

function labelOf(path) {
  return path.split("/").pop().split("-")[0];
}

async function followTraffic() {
  const initialFiles = selectedFiles();
  if (options.files.length > 0) renderFiles(initialFiles, options);
  else if (initialFiles.length > 0) {
    console.log(`从现有文件末尾开始跟随：${initialFiles.join("、")}`);
  }
  console.log(`跟随 ${directory} 中的新内容，按 Ctrl-C 停止`);
  const tails = new Map();
  for (const path of listDumpFiles()) {
    tails.set(path, { offset: fileSize(path), remainder: "" });
  }
  const sseBuffers = new Map();
  const frameBuffers = new Map();
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopped) {
    await sleep(followIntervalMs);
    for (const path of listDumpFiles()) {
      const tail = tails.get(path) ?? { offset: 0, remainder: "" };
      tails.set(path, tail);
      const content = readFrom(path, tail.offset);
      if (content.length === 0) continue;
      tail.offset += Buffer.byteLength(content);
      const lines = `${tail.remainder}${content}`.split("\n");
      tail.remainder = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        renderFollowRecord(JSON.parse(line), sseBuffers, frameBuffers);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readFrom(path, offset) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
  } catch {
    return "";
  }
  try {
    const { size } = fstatSync(descriptor);
    if (size <= offset) return "";
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const chunk = readSync(descriptor, buffer, read, length - read, offset + read);
      if (chunk === 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

function renderFollowRecord(record, sseBuffers, frameBuffers) {
  if (options.exchange !== undefined && record.exchange !== options.exchange) return;
  const prefix = `[${formatTime(record.ts ?? record.startedAtMs)}] #${record.exchange}`;
  const emit = (text) => {
    if (options.grep !== undefined && !text.includes(options.grep)) return;
    const [first, ...rest] = text.split("\n");
    console.log(`${prefix} ${first}`);
    for (const line of rest) console.log(`          ${line}`);
  };
  switch (record.kind) {
    case "request_head": {
      const metadata = parseTurnMetadata(record.headers?.["x-codex-turn-metadata"]);
      emit(`${record.method} ${record.path}  线程=${shortId(metadata.threadId)}  `
        + `轮次=${shortId(metadata.turnId)}  类型=${metadata.requestKind ?? "-"}`);
      break;
    }
    case "request_body":
      emit("请求体：\n" + jsonOrText(String(record.text ?? ""), options.maxBytes));
      break;
    case "response_head":
      emit(`响应状态 ${record.status}`);
      break;
    case "response_body": {
      const pending = `${sseBuffers.get(record.exchange) ?? ""}${record.text ?? ""}`;
      const blocks = pending.split("\n\n");
      sseBuffers.set(record.exchange, blocks.pop() ?? "");
      for (const block of blocks) {
        for (const event of parseSseEvents(`${block}\n\n`)) {
          emit(`[${event.type}]\n${renderEventPayload(event, options.maxBytes)}`);
        }
      }
      break;
    }
    case "response_end":
    case "websocket_close":
    case "error": {
      flushSseBuffer(record.exchange, sseBuffers, emit);
      flushFrameBuffers(record.exchange, frameBuffers, emit);
      if (record.kind === "response_end") {
        emit(`响应结束 ${record.bytes ?? 0} 字节，用时 ${record.durationMs ?? "-"} ms`);
      } else if (record.kind === "websocket_close") {
        emit(`连接关闭 ${record.peer} code=${record.code}`
          + (record.reason === undefined ? "" : ` 原因=${record.reason}`));
      } else {
        emit(`中断 ${record.scope}${record.message === undefined ? "" : ` ${record.message}`}`);
      }
      break;
    }
    case "websocket_handshake":
      emit(`WebSocket ${record.url}`);
      break;
    case "websocket_frame": {
      const key = `${record.exchange}:${record.direction}`;
      const text = `${frameBuffers.get(key) ?? ""}${frameText(record)}`;
      if (record.part < record.parts) {
        frameBuffers.set(key, text);
        break;
      }
      frameBuffers.delete(key);
      emit(`${record.direction === "client" ? "发出" : "返回"}：\n`
        + jsonOrText(text, options.maxBytes));
      break;
    }
    default:
      break;
  }
}

function flushSseBuffer(exchangeId, sseBuffers, emit) {
  const pending = sseBuffers.get(exchangeId);
  sseBuffers.delete(exchangeId);
  if (pending === undefined || pending.trim().length === 0) return;
  for (const event of parseSseEvents(`${pending}\n\n`)) {
    emit(`[${event.type}]\n${renderEventPayload(event, options.maxBytes)}`);
  }
}

function flushFrameBuffers(exchangeId, frameBuffers, emit) {
  for (const [key, text] of [...frameBuffers]) {
    if (!key.startsWith(`${exchangeId}:`)) continue;
    frameBuffers.delete(key);
    const direction = key.slice(key.indexOf(":") + 1);
    emit(`${direction === "client" ? "发出" : "返回"}：\n`
      + jsonOrText(text, options.maxBytes));
  }
}

function renderFiles(paths, options) {
  if (paths.length === 0) {
    console.error(`没有找到转储文件：${options.directory ?? directory}`);
    process.exitCode = 1;
    return;
  }
  const unreadable = paths.filter((path) => {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats === undefined || !stats.isFile();
  });
  if (unreadable.length > 0) {
    console.error(
      `转储文件不存在：${unreadable.join("、")}\n`
      + "列出 exchange 摘要请使用 --list，查看全部选项请使用 -h。",
    );
    process.exitCode = 1;
    return;
  }
  const records = paths.flatMap((path) => readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line)));
  const exchanges = groupExchanges(records);
  if (options.exchange !== undefined && !exchanges.some(({ id }) => id === options.exchange)) {
    const ids = exchanges.map(({ id }) => id);
    console.error(
      `没有找到 exchange #${options.exchange}：${paths.join("、")} `
      + (ids.length === 0
        ? "没有 exchange 记录。"
        : `编号范围是 #${Math.min(...ids)}–#${Math.max(...ids)}。`),
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\n### ${paths.join("\n### ")}（${exchanges.length} 个 exchange）`);
  const detail = !options.list && (options.all || options.exchange !== undefined);
  if (!detail) {
    for (const exchange of exchanges) {
      if (options.exchange !== undefined && exchange.id !== options.exchange) continue;
      const line = summaryLine(exchange);
      if (options.grep !== undefined && !line.includes(options.grep)) continue;
      console.log(line);
    }
    return;
  }
  for (const exchange of exchanges) {
    if (options.exchange !== undefined && exchange.id !== options.exchange) continue;
    const text = renderExchange(exchange, options);
    if (options.grep !== undefined && !text.includes(options.grep)) continue;
    console.log(text);
  }
}

function groupExchanges(records) {
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

function summaryLine(exchange) {
  const head = findRecord(exchange, "request_head");
  const handshake = findRecord(exchange, "websocket_handshake");
  const responseHead = findRecord(exchange, "response_head");
  const metadata = requestMetadata(exchange);
  const parts = [
    `#${exchange.id}`,
    formatTime(exchange.startedAtMs),
    head !== undefined ? `${head.method} ${head.path}` : `WebSocket ${handshake?.url ?? ""}`,
    `线程=${shortId(metadata.threadId)}`,
    `轮次=${shortId(metadata.turnId)}`,
    `类型=${metadata.requestKind ?? "-"}`,
  ];
  if (responseHead !== undefined) parts.push(`状态=${responseHead.status}`);
  if (findRecord(exchange, "error") !== undefined) parts.push("有中断记录");
  return parts.join("  ");
}

function renderExchange(exchange, options) {
  const head = findRecord(exchange, "request_head");
  const handshake = findRecord(exchange, "websocket_handshake");
  const metadata = requestMetadata(exchange);
  const lines = [
    "",
    `#${exchange.id} ${formatTime(exchange.startedAtMs)} `
      + (head !== undefined ? `${head.method} ${head.path}` : `WebSocket ${handshake?.url ?? ""}`),
  ];
  if (exchange.account !== undefined) lines.push(`账户：${exchange.account}`);
  lines.push(
    `线程：${metadata.threadId ?? "未提供"}  轮次：${metadata.turnId ?? "未提供"}  `
    + `类型：${metadata.requestKind ?? "未提供"}`,
  );
  const requestModel = requestModelOf(exchange);
  const responseModels = responseModelsOf(exchange);
  lines.push(
    `模型：请求 ${requestModel ?? "未提供"}  响应 `
    + (responseModels.length > 0 ? responseModels.join("、") : "未提供"),
  );
  if (head !== undefined) {
    lines.push("", "请求头：", ...headerLines(head.headers));
  } else if (handshake !== undefined) {
    lines.push("", "握手请求头：", ...headerLines(handshake.headers));
  }
  const requestBody = joinBodies(exchange, "request_body");
  if (requestBody.length > 0) {
    lines.push("", "请求体：", indent(jsonOrText(requestBody, options.maxBytes)));
  }
  const responseHead = findRecord(exchange, "response_head");
  if (responseHead !== undefined) {
    lines.push("", `响应状态：${responseHead.status}`, ...headerLines(responseHead.headers));
  }
  const responseBody = joinBodies(exchange, "response_body");
  if (responseBody.length > 0) {
    lines.push("", "响应体：", ...renderResponseBody(responseBody, options.maxBytes));
  }
  for (const frame of websocketFrames(exchange)) {
    const arrow = frame.direction === "client" ? "→ App Server 发出" : "← 上游返回";
    lines.push("", `${arrow}：`, indent(jsonOrText(String(frame.text ?? ""), options.maxBytes)));
  }
  for (const record of exchange.records) {
    if (record.kind === "websocket_close") {
      lines.push("", `连接关闭：${record.peer} code=${record.code}`
        + (record.reason === undefined ? "" : ` 原因=${record.reason}`));
    } else if (record.kind === "error") {
      lines.push("", `中断：${record.scope}`
        + (record.message === undefined ? "" : ` ${record.message}`));
    }
  }
  return lines.join("\n");
}

function renderResponseBody(body, maxBytes) {
  const events = parseSseEvents(body);
  if (events.length === 0) return [indent(jsonOrText(body, maxBytes))];
  return events.flatMap((event) => [
    `  [${event.type}]`,
    ...indent(renderEventPayload(event, maxBytes)).split("\n"),
  ]);
}

function renderEventPayload(event, maxBytes) {
  return event.parsed === undefined
    ? bounded(event.raw, maxBytes)
    : bounded(JSON.stringify(event.parsed, null, 2), maxBytes);
}

function parseSseEvents(text) {
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

function jsonOrText(text, maxBytes) {
  try {
    return bounded(JSON.stringify(JSON.parse(text), null, 2), maxBytes);
  } catch {
    return bounded(text, maxBytes);
  }
}

function bounded(text, maxBytes) {
  if (maxBytes === undefined || !Number.isFinite(maxBytes)) return text;
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return text;
  const head = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${head}\n…（本段共 ${bytes} 字节，已按 --max-bytes 截断 ${bytes - maxBytes} 字节）`;
}

function indent(text) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

function headerLines(headers) {
  return Object.entries(headers ?? {}).map(([name, value]) => (
    `  ${name}: ${Array.isArray(value) ? value.join(", ") : String(value)}`
  ));
}

function joinBodies(exchange, kind) {
  return recordsOfKind(exchange, kind)
    .sort((left, right) => left.part - right.part)
    .map((record) => (typeof record.text === "string"
      ? record.text
      : `<${record.encoding ?? "binary"} ${record.bytes ?? 0} 字节>`))
    .join("");
}

function requestMetadata(exchange) {
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

function requestModelOf(exchange) {
  const body = joinBodies(exchange, "request_body");
  const parsed = body.length > 0 ? parseJson(body) : undefined;
  if (typeof parsed?.model === "string") return parsed.model;
  for (const frame of websocketFrames(exchange)) {
    if (frame.direction !== "client") continue;
    const model = parseJson(String(frame.text ?? ""))?.model;
    if (typeof model === "string") return model;
  }
  return undefined;
}

function responseModelsOf(exchange) {
  const found = new Set();
  for (const payload of responsePayloads(exchange)) {
    const model = payload?.response?.model ?? payload?.model;
    if (typeof model === "string") found.add(model);
  }
  return [...found];
}

function responsePayloads(exchange) {
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

/**
 * 单帧超过转储上限时会被切分为多条 `part` 记录，这里按方向和连续序号还原成完整帧；
 * 二进制帧只保留长度占位，不参与 JSON 解析。
 */
function websocketFrames(exchange) {
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

function frameText(record) {
  return typeof record.text === "string"
    ? record.text
    : `<二进制帧 ${record.bytes ?? 0} 字节>`;
}

function parseTurnMetadata(value) {
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function recordsOfKind(exchange, kind) {
  return exchange.records.filter((record) => record.kind === kind);
}

function findRecord(exchange, kind) {
  return exchange.records.find((record) => record.kind === kind);
}

function shortId(value) {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 8) : "-";
}

function formatTime(atMs) {
  if (typeof atMs !== "number") return "-";
  const date = new Date(atMs);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
