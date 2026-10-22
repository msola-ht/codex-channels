import { validRequestTiming } from "../runtime/request-timing.mjs";
import { projectTrafficDumpManifest } from "../runtime/traffic-dump-manifest.mjs";
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  lstatSync,
  readSync,
  readdirSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { lstat, open, opendir } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { setImmediate as yieldReading } from "node:timers/promises";

import { callTiming, createModelEvidenceCollector, createOutputCollector, failureStage, parameterComparison, requestClientName, requestContent, requestMetadata, requestParameters, requestProtocol, responseFacts } from "./traffic-dump-presentation.mjs";

const manifestName = "manifest.json";
const interactionFileName = "interactions.jsonl";
const maximumManifestBytes = 1_048_576;
// Production writers admit at most 14 MiB per pending batch (trace: 4 MiB).
const maximumLineBytes = 16 * 1_048_576;

/** HTTP 一次读取的共同预算；CLI 与清理不创建该上下文，保留原契约。 */
export function createTrafficReadContext(signal) {
  const remaining = { bytes: 128 * 1_048_576, records: 100_000, entries: 20_000, files: 2_048 };
  const deadline = performance.now() + 10_000;
  let steps = 0;
  return {
    signal,
    manifests: new Map(),
    directories: new Map(),
    check() {
      if (signal.aborted) throw signal.reason instanceof TrafficDumpReadError
        ? signal.reason : new TrafficDumpReadError("traffic_read_cancelled", "调用记录读取已取消");
      if (performance.now() >= deadline) throw new TrafficDumpReadError("traffic_read_timeout", "调用记录读取超过 10 秒期限，请缩小批次范围");
    },
    charge(kind, count = 1) {
      this.check();
      remaining[kind] -= count;
      if (remaining[kind] < 0) throw new TrafficDumpReadError("traffic_read_limit", "调用记录读取超过整体工作预算，请缩小批次范围");
    },
    async checkpoint() {
      this.check();
      // 即使文件全部在缓存中，也让断连、服务停止与到期事件获得执行机会。
      if (++steps % 64 === 0) await yieldReading();
      this.check();
    },
  };
}

export class TrafficDumpReadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** 异步目录与 manifest 读取，避免 HTTP 扫描退回同步 CLI catalog。 */
export async function readDumpCatalog(directory, context) {
  context.check();
  const metadata = await lstat(directory).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return { files: [], labels: [], sessions: [] };
  if (!metadata.isDirectory()) throw new Error("模型流量目录类型无效");
  context.rootDirectory = resolve(directory);
  context.directories.set(context.rootDirectory, metadata);
  const sessions = [];
  for (const entry of await readDirectoryEntries(directory, context)) {
    await context.checkpoint();
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name);
    let buffer;
    try { buffer = await readFileSliceAsync(join(path, manifestName), 0, maximumManifestBytes, true, context, true); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (buffer === undefined) continue;
    const manifest = validateManifest(parseJson(buffer.toString("utf8")), path);
    if (manifest.version !== 2) throw new TrafficDumpReadError("traffic_unsupported_version", "不支持的模型流量转储版本");
    context.manifests.set(resolve(path), manifest);
    sessions.push({ ...manifest, path });
  }
  context.check();
  return catalogOf(sessions);
}

export function listDumpFiles(directory) {
  return dumpCatalog(directory).files;
}

export function dumpCatalog(directory) {
  if (!existsSync(directory)) return { files: [], labels: [], sessions: [] };
  assertDumpDirectory(directory);
  const sessions = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(path);
    if (manifest === undefined) continue;
    if (manifest.version !== 2) {
      throw new Error(`不支持的模型流量转储版本：${manifest.version}`);
    }
    sessions.push({ ...manifest, path });
  }
  return catalogOf(sessions);
}

function catalogOf(sessions) {
  sessions.sort((left, right) => left.createdAtMs - right.createdAtMs);
  const groups = new Map();
  for (const entry of sessions) {
    const group = groups.get(entry.label) ?? { label: entry.label, sessions: 0, latestAtMs: -Infinity };
    group.sessions += 1;
    group.latestAtMs = Math.max(group.latestAtMs, entry.createdAtMs);
    groups.set(entry.label, group);
  }
  const labels = [...groups.values()]
    .sort((left, right) => right.latestAtMs - left.latestAtMs
      || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
  return {
    files: sessions.map((entry) => entry.path), labels,
    sessions: sessions.map(({ label, session, createdAtMs }) => ({ label, session, createdAtMs })),
  };
}

export function labelOf(path, context) {
  return manifestOf(path, context)?.label;
}

export function writerSessionOf(path, context) {
  return manifestOf(path, context)?.session;
}

export function selectFilesOfLabel(paths, label, requestedSession, context) {
  return paths.filter((path) => {
    const manifest = manifestOf(path, context);
    return manifest?.label === label
      && (requestedSession === undefined || manifest.session === requestedSession);
  });
}

export async function forEachDumpRecord(paths, visit, context) {
  for (const directory of sessionDirectories(paths, context)) {
    await context?.checkpoint();
    const path = join(directory, interactionFileName);
    if (context ? !await fileExists(path, context) : !existsSync(path)) continue;
    let pendingLine;
    for await (const line of dumpLines(path, context)) {
      context?.charge("records");
      await context?.checkpoint();
      if (line.length === 0) continue;
      if (pendingLine !== undefined) await visitIndexLine(pendingLine, directory, visit, false);
      pendingLine = line;
    }
    if (pendingLine !== undefined) await visitIndexLine(pendingLine, directory, visit, true);
  }
}

export async function summarizeDumpFiles(paths, { limit, offset = 0, newestFirst = false, context } = {}) {
  const page = limit === undefined
    ? await readAllInteractionSummaries(paths, newestFirst, context)
    : await readInteractionSummaryPage(paths, offset + limit, newestFirst, context);
  const boundedLimit = limit ?? page.entries.length;
  const entries = page.entries.slice(offset, offset + boundedLimit);
  const exchanges = [];
  for (const entry of entries) {
    await context?.checkpoint();
    const body = parseJson((await readPayload(entry.directory, entry.request.payload, 4 * 1_048_576, true, context)).text);
    const includeMetadata = entry.request.transport === "websocket"
      && (entry.request.requestKind === undefined || entry.request.requestKind === "prewarm");
    exchanges.push(summaryOf(entry, body, includeMetadata, context));
  }
  return {
    exchanges,
    total: page.total,
    nextOffset: offset + exchanges.length < page.total ? offset + exchanges.length : null,
  };
}

export async function readDumpExchange(paths, id, context) {
  if (sessionDirectories(paths, context).length !== 1) {
    throw new Error("读取模型调用明细必须指定一个 V2 session");
  }
  const directory = sessionDirectories(paths, context)[0];
  let interaction;
  await forEachDumpRecord(paths, (record, recordDirectory) => {
    if ((record.kind !== "request" && record.kind !== "response") || record.id !== id) return;
    interaction ??= { directory: recordDirectory, session: writerSessionOf(directory, context) };
    interaction[record.kind] = record;
  }, context);
  return interaction?.request === undefined ? null : interaction;
}

export async function forEachDumpExchange(paths, visit) {
  const interactions = await readInteractions(paths);
  const ordered = [...interactions.values()]
    .filter((entry) => entry.request !== undefined)
    .sort((left, right) => left.request.id - right.request.id);
  for (const interaction of ordered) await visit(interaction);
}

export async function describeDumpExchange(
  paths,
  id,
  { traceOffset = 0, maxTracePageSize = 100, maxSectionBytes = 4 * 1_048_576, context } = {},
) {
  const interaction = await readDumpExchange(paths, id, context);
  if (interaction?.request === undefined) return null;
  const directory = interaction.directory;
  const requestPayload = await readPayload(directory, interaction.request.payload, maxSectionBytes, false, context);
  const responsePayload = await readPayload(directory, interaction.response?.payload, maxSectionBytes, false, context);
  const requestBody = parseJson(requestPayload.text);
  const responseBody = parseJson(responsePayload.text);
  const facts = responseFacts(responseBody);
  const models = createModelEvidenceCollector();
  models.headers(interaction.response?.headers, "http.headers");
  models.event(responseBody);
  const chat = responseBody?.success === true ? responseBody.data : responseBody;
  const chatOutput = Array.isArray(chat?.choices) ? chat.choices.flatMap(choice => choice?.message && typeof choice.message === "object" && !Array.isArray(choice.message)
    ? [{ type: "message", ...choice.message }] : []) : undefined;
  let streamFacts;
  const nativeResponses = interaction.response?.capture === "redacted_upstream_responses";
  let terminalResponse = nativeResponses && ["completed", "failed", "incomplete"].includes(responseBody?.status) ? responseBody : undefined;
  const output = createOutputCollector(maxSectionBytes, (responseBody?.response ?? responseBody)?.output ?? chatOutput, value => {
    models.event(value);
    if (interaction.response?.capture === "redacted_upstream_chat" && Array.isArray(value?.choices) && value.usage != null) streamFacts = responseFacts(value);
    if (nativeResponses && ["response.completed", "response.failed", "response.incomplete"].includes(value?.type)
      && value.type === `response.${value.response?.status}` && Array.isArray(value.response?.output)) {
      terminalResponse = value.response; streamFacts = responseFacts(value);
    }
  });
  if (interaction.response?.capture === "redacted_upstream_chat" || nativeResponses && responseBody === undefined) {
    output.consume({ kind: "response_body", encoding: "utf8", text: responsePayload.text });
  }
  const trace = await readTrace(directory, id, traceOffset, maxTracePageSize, maxSectionBytes, output, interaction, context);
  const continuation = await readContinuation(interaction, context);
  const collected = output.result();
  // Read existing V2 dumps using their explicit terminal payload; never rewrite archived data.
  if (terminalResponse && interaction.response.state === "completed") {
    interaction.response = { ...interaction.response, state: terminalResponse.status };
  }
  return {
    ...summaryOf(interaction, requestBody, true, context),
    ...await debugDetail(interaction, maxSectionBytes, context),
    modelEvidence: models.result(),
    chatDiagnostics: trace.chatDiagnostics,
    continuation,
    parameterComparison: parameterComparison(requestBody, responseBody),
    request: {
      headers: interaction.request.headers ?? {},
      headersTruncated: interaction.request.headersTruncated === true,
      method: interaction.request.method,
      path: interaction.request.path,
      url: interaction.request.url,
      body: requestPayload.text,
      bodyTruncated: requestPayload.truncated,
      bytes: interaction.request.bytes ?? interaction.request.payload?.bytes,
      storedBytes: interaction.request.payload?.bytes,
      parameters: requestParameters(requestBody, requestProtocol(interaction.request)),
      content: requestContent(requestBody),
    },
    response: interaction.response === undefined ? null : {
      state: interaction.response.state,
      status: interaction.response.status ?? null,
      headers: interaction.response.headers ?? {},
      headersTruncated: interaction.response.headersTruncated === true,
      body: responsePayload.text,
      bodyTruncated: responsePayload.truncated,
      bytes: interaction.response.bytes ?? interaction.response.payload?.bytes,
      durationMs: callTiming(interaction.response.callTiming)?.totalMs,
      firstTokenMs: interaction.response.firstTokenMs,
      ...outputTimingOf(interaction.response),
      callTiming: callTiming(interaction.response.callTiming),
      eventType: interaction.response.eventType,
      errorScope: interaction.response.errorScope,
      websocketClose: trace.websocketClose,
      failureStage: failureStage(interaction.response, responseBody, trace.chatDiagnostics?.fields?.["error.timeoutStage"]),
      error: interaction.response.error,
      capture: interaction.response.capture,
      deliveryStatus: interaction.response.deliveryStatus,
      storedBytes: interaction.response.payload?.bytes,
      ...(streamFacts ?? facts),
      ...collected,
      ...(responsePayload.truncated || interaction.response.traceTruncated === true && collected.outputSource === "trace"
        ? { outputTruncated: true } : {}),
    },
    trace: trace.items,
    tracePage: trace.page,
  };
}

/** 只关联同一 writer 中的原始 Thread/Turn，不使用审查请求投影后的父身份。 */
async function readContinuation(interaction, context) {
  const { request, response, directory } = interaction;
  if (request.transport !== "websocket" || request.requestKind !== "turn"
    || response?.state !== "incomplete" || response.errorScope !== "websocket_client_closed") return undefined;
  const validIdentity = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
  if (!validIdentity(request.threadId) || !validIdentity(request.turnId)
    || !Number.isFinite(response.ts)) return undefined;
  let next;
  // 保留一个候选，不读取其他请求正文；缺失身份时不按时间或模型猜配。
  await forEachDumpRecord([directory], record => {
    if (record.kind === "request" && Number.isSafeInteger(record.id) && record.id > request.id
      && record.transport === "websocket" && record.requestKind === "turn"
      && record.threadId === request.threadId && record.turnId === request.turnId
      && record.account === request.account && record.url === request.url
      && Number.isFinite(record.startedAtMs) && record.startedAtMs >= response.ts
      && (next === undefined || record.id < next.request.id)) next = { request: record };
    if (record.kind === "response" && next?.request.id === record.id) next.response = record;
  }, context);
  if (next === undefined) return { scope: "same_writer_thread_turn", next: null };
  // 只报告已保留输入中存在代理消息，不推断“新增”、重试或取消原因。
  const payload = await readPayload(directory, next.request.payload, 1_048_576, true, context);
  const body = parseJson(payload.text);
  const agentMessageObserved = Array.isArray(body?.input)
    && body.input.some(item => item?.type === "agent_message");
  return {
    scope: "same_writer_thread_turn",
    next: {
      id: next.request.id,
      startedAtMs: next.request.startedAtMs,
      gapMs: next.request.startedAtMs - response.ts,
      state: ["completed", "failed", "incomplete"].includes(next.response?.state) ? next.response.state : "pending",
      agentMessageObserved,
    },
  };
}

/** 事件翻页不读取正文，也不重新构建输出与模型证据。 */
export async function describeDumpTrace(paths, id, {
  traceOffset = 0, maxTracePageSize = 100, maxSectionBytes = 4 * 1_048_576, context,
} = {}) {
  const interaction = await readDumpExchange(paths, id, context);
  if (interaction?.request === undefined) return null;
  const trace = await readTrace(interaction.directory, id, traceOffset, maxTracePageSize, maxSectionBytes, undefined, undefined, context);
  return { id, trace: trace.items, tracePage: trace.page };
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function shortId(value) {
  return typeof value !== "string" ? "-" : value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

function readManifest(directory) {
  const path = join(directory, manifestName);
  if (!existsSync(path)) return undefined;
  let value;
  try {
    const descriptor = openDumpFile(path);
    try {
      const size = fstatSync(descriptor).size;
      if (size > maximumManifestBytes) throw new Error("manifest exceeds read limit");
      const buffer = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const count = readSync(descriptor, buffer, read, size - read, read);
        if (count === 0) break;
        read += count;
      }
      value = JSON.parse(buffer.subarray(0, read).toString("utf8"));
    } finally { closeSync(descriptor); }
  } catch {
    throw new Error(`模型流量 manifest 无效：${directory}`);
  }
  return validateManifest(value, directory);
}

function validateManifest(value, directory) {
  const manifest = projectTrafficDumpManifest(value);
  if (manifest === undefined) throw new Error(`模型流量 manifest 无效：${directory}`);
  return manifest;
}

async function visitIndexLine(line, directory, visit, allowTornTail) {
  const record = parseJson(line);
  if (record === undefined && allowTornTail) return;
  if (record?.version !== 2) {
    throw new Error(`不支持的模型流量索引版本：${record?.version ?? "缺失"}`);
  }
  await visit(record, directory);
}

function manifestOf(path, context) {
  if (context) {
    context.check();
    const manifest = context.manifests.get(resolve(path));
    if (manifest === undefined) throw new Error("模型流量 session 未在本次目录读取中确认");
    return manifest;
  }
  return readManifest(sessionDirectoryOf(path));
}

function sessionDirectoryOf(path, context) {
  const resolved = resolve(path);
  if (context) {
    manifestOf(resolved, context);
    return resolved;
  }
  const stats = lstatSync(resolved, { throwIfNoEntry: false });
  const directory = stats?.isDirectory() || basename(resolved) !== interactionFileName
    ? resolved
    : resolve(resolved, "..");
  assertDumpDirectory(directory);
  const manifest = readManifest(directory);
  if (manifest?.version !== 2) throw new Error("仅支持 V2 模型流量 session");
  return directory;
}

function sessionDirectories(paths, context) {
  return [...new Set(paths.map(path => sessionDirectoryOf(path, context)))];
}

async function readInteractions(paths, context) {
  const interactions = new Map();
  const sessions = new Map(sessionDirectories(paths, context).map((directory) => [directory, writerSessionOf(directory, context)]));
  await forEachDumpRecord(paths, (record, directory) => {
    if (record.kind !== "request" && record.kind !== "response") return;
    if (!Number.isSafeInteger(record.id) || record.id < 1) return;
    const key = join(directory, String(record.id));
    const entry = interactions.get(key) ?? { directory, session: sessions.get(directory) };
    entry[record.kind] = record;
    interactions.set(key, entry);
  }, context);
  return interactions;
}

async function readAllInteractionSummaries(paths, newestFirst, context) {
  const interactions = await readInteractions(paths, context);
  const entries = [...interactions.values()]
    .filter((entry) => entry.request !== undefined)
    .sort((left, right) => compareInteraction(left, right, newestFirst));
  return { entries, total: entries.length };
}

/** 只保留当前页之前的候选；响应通过 session + id 回填，不缓存页外调用。 */
async function readInteractionSummaryPage(paths, maximumEntries, newestFirst, context) {
  const entries = [];
  const selected = new Map();
  const compare = (left, right) => compareInteraction(left, right, newestFirst);
  const sessions = new Map(sessionDirectories(paths, context)
    .map((directory) => [directory, writerSessionOf(directory, context)]));
  let total = 0;
  await forEachDumpRecord(paths, (record, directory) => {
    if (record.kind !== "request" && record.kind !== "response") return;
    if (!Number.isSafeInteger(record.id) || record.id < 1) return;
    const key = join(directory, String(record.id));
    if (record.kind === "response") {
      const entry = selected.get(key);
      if (entry !== undefined) entry.response = record;
      return;
    }
    total += 1;
    if (maximumEntries <= 0) return;
    const entry = { directory, key, request: record, session: sessions.get(directory) };
    if (entries.length < maximumEntries) {
      entries.push(entry);
      selected.set(key, entry);
      siftWorstUp(entries, entries.length - 1, compare);
      return;
    }
    if (compare(entry, entries[0]) >= 0) return;
    selected.delete(entries[0].key);
    entries[0] = entry;
    selected.set(key, entry);
    siftWorstDown(entries, 0, compare);
  }, context);
  entries.sort(compare);
  return { entries, total };
}

/** 维护“最差候选在堆顶”的有界堆，避免按时间倒序时反复移动整个数组。 */
function siftWorstUp(heap, start, compare) {
  let index = start;
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (compare(heap[parent], heap[index]) >= 0) return;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function siftWorstDown(heap, start, compare) {
  let index = start;
  for (;;) {
    const left = index * 2 + 1;
    if (left >= heap.length) return;
    const right = left + 1;
    let worse = left;
    if (right < heap.length && compare(heap[right], heap[left]) > 0) worse = right;
    if (compare(heap[index], heap[worse]) >= 0) return;
    [heap[index], heap[worse]] = [heap[worse], heap[index]];
    index = worse;
  }
}

function compareInteraction(left, right, newestFirst) {
  return newestFirst
    ? right.request.startedAtMs - left.request.startedAtMs
      || right.session.localeCompare(left.session) || right.request.id - left.request.id
    : left.request.id - right.request.id;
}

function summaryOf(interaction, body, includeMetadata = true, context) {
  const request = interaction.request;
  const response = interaction.response;
  const relay = ["relay.chat", "relay.responses"].includes(labelOf(interaction.directory, context));
  const projectedMetadata = relay ? {} : requestMetadata(body, request.transport === "http" ? request.headers ?? {} : undefined);
  // V2 索引仍保留原始 reviewer 身份；即便摘要已含索引字段，也必须用已存元数据投影父任务。
  const metadata = includeMetadata || projectedMetadata.requestPurpose !== undefined ? projectedMetadata : {};
  const requestKind = relay ? undefined : metadata.requestKind ?? (includeMetadata && body?.generate === false ? "prewarm" : request.requestKind);
  const firstTokenMs = firstTokenMsOf(response);
  const clientName = requestClientName(request);
  const protocol = requestProtocol(request);
  const reasoningEffort = requestParameters(body, protocol).reasoningEffort;
  return {
    id: request.id,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(clientName === undefined ? {} : { clientName }),
    ...(protocol === undefined ? {} : { protocol }),
    label: labelOf(interaction.directory, context),
    session: interaction.session,
    startedAtMs: request.startedAtMs,
    ...(request.account === undefined ? {} : { account: request.account }),
    transport: request.transport,
    ...(request.method === undefined ? {} : { method: request.method }),
    ...(request.path === undefined ? {} : { path: request.path }),
    ...(request.url === undefined ? {} : { url: request.url }),
    ...(request.threadId === undefined ? {} : { threadId: request.threadId }),
    ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
    ...(request.requestKind === undefined ? {} : { requestKind: request.requestKind }),
    ...(request.requestModel === undefined ? {} : { requestModel: request.requestModel }),
    ...(metadata.threadId === undefined ? {} : { threadId: metadata.threadId }),
    ...(metadata.turnId === undefined ? {} : { turnId: metadata.turnId }),
    ...(metadata.requestPurpose === undefined ? {} : {
      requestPurpose: metadata.requestPurpose,
      reviewerThreadId: metadata.reviewerThreadId,
      reviewerTurnId: metadata.reviewerTurnId,
    }),
    ...(requestKind === undefined ? {} : { requestKind }),
    category: request.method === "GET" && request.path?.split("?")[0] === "/models"
      ? "models" : requestKind === "prewarm" ? "prewarm" : "model",
    ...(upstreamProviderOf(response) === undefined ? {} : { upstreamProvider: upstreamProviderOf(response) }),
    responseModels: response?.responseModels ?? [],
    state: response?.state ?? "pending",
    status: response?.status,
    durationMs: callTiming(response?.callTiming)?.totalMs,
    ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
    ...outputTimingOf(response),
    hasError: response?.state === "failed" || response?.state === "incomplete",
  };
}

/** 索引里的 Chat 上游提供商；只有明确记录过字符串值时返回，缺失或类型无效一律省略。 */
function upstreamProviderOf(response) {
  const value = response?.upstreamProvider;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 索引里的首 Token 延迟；缺失或非法数值不进入摘要，读取端缺失即显示未知。 */
function firstTokenMsOf(response) {
  const value = response?.firstTokenMs;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function outputTimingOf(response) {
  if (!response || !validRequestTiming(response)) return {};
  return {
    ...(response.responseTimeMs == null ? {} : { responseTimeMs: response.responseTimeMs }),
    ...(response.generationTiming == null ? {} : { generationTiming: response.generationTiming }),
    ...(Number.isSafeInteger(response.outputTokens) && response.outputTokens >= 0 ? { outputTokens: response.outputTokens } : {}),
  };
}

async function readPayload(directory, payload, maxBytes, allowUnavailable = false, context) {
  context?.check();
  if (payload === undefined || !Array.isArray(payload.parts)) return { text: "", truncated: false };
  const buffers = [];
  let remaining = maxBytes;
  let truncated = payload.truncated === true;
  for (const part of payload.parts) {
    await context?.checkpoint();
    context?.charge("records");
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    assertPayloadPart(part);
    const length = Math.min(part.bytes, remaining);
    const buffer = context
      ? await readFileSliceAsync(join(directory, part.file), part.offset, length, allowUnavailable, context)
      : readFileSlice(join(directory, part.file), part.offset, length, allowUnavailable);
    if (buffer === undefined) return { text: "", truncated: true };
    buffers.push(part.encoding === "utf8"
      ? buffer
      : Buffer.from(`<二进制正文 ${part.bytes} 字节>`));
    remaining -= buffer.length;
    if (length < part.bytes) truncated = true;
  }
  return { text: Buffer.concat(buffers).toString("utf8"), truncated };
}

function assertPayloadPart(part) {
  if (typeof part !== "object" || part === null
    || !/^payload-[1-9][0-9]*\.bin$/u.test(part.file)
    || !Number.isSafeInteger(part.offset) || part.offset < 0
    || !Number.isSafeInteger(part.bytes) || part.bytes < 0
    || (part.encoding !== "utf8" && part.encoding !== "base64")) {
    throw new Error("模型流量正文引用无效");
  }
}

function readFileSlice(path, offset, length, allowUnavailable = false) {
  let descriptor;
  try { descriptor = openDumpFile(path); }
  catch (error) {
    if (allowUnavailable && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const size = fstatSync(descriptor).size;
    if (offset + length > size) {
      if (allowUnavailable) return undefined;
      throw new Error("模型流量正文引用超出文件范围");
    }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const count = readSync(descriptor, buffer, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    return buffer.subarray(0, read);
  } finally {
    closeSync(descriptor);
  }
}

async function* traceRecords(directory, context) {
  const paths = (context ? (await readDirectoryEntries(directory, context)).map(entry => entry.name) : readdirSync(directory))
    .filter((name) => /^trace-[1-9][0-9]*\.jsonl$/u.test(name))
    .sort((left, right) => numericSuffix(left) - numericSuffix(right));
  for (const path of paths) {
    await context?.checkpoint();
    for await (const line of dumpLines(join(directory, path), context)) {
      context?.charge("records");
      await context?.checkpoint();
      yield parseJson(line);
    }
  }
}

function assertDumpDirectory(path) {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory()) throw new Error("模型流量目录类型无效，不能使用符号链接");
  return metadata;
}

function openDumpFile(path) {
  const parent = assertDumpDirectory(dirname(path));
  const before = lstatSync(path);
  if (!before.isFile()) throw new Error("模型流量文件类型无效，不能使用符号链接");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    const current = lstatSync(path);
    const currentParent = assertDumpDirectory(dirname(path));
    if (!opened.isFile() || !current.isFile()
      || before.dev !== opened.dev || before.ino !== opened.ino
      || current.dev !== opened.dev || current.ino !== opened.ino
      || parent.dev !== currentParent.dev || parent.ino !== currentParent.ino) {
      throw new Error("模型流量文件在读取时被替换");
    }
    return descriptor;
  } catch (error) { closeSync(descriptor); throw error; }
}

async function* dumpLines(path, context) {
  const handle = context ? await openDumpFileAsync(path, context) : undefined;
  const stream = handle
    ? handle.createReadStream({ autoClose: true, signal: context.signal })
    : createReadStream(path, { fd: openDumpFile(path), autoClose: true });
  // 安装完成监听早于消费；取消后仍等实际 close，调用方才释放并发名额。
  const closed = finished(stream).catch(() => {});
  let chunks = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      context?.charge("bytes", chunk.length);
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 ? chunk.length : newline;
        bytes += end - start;
        if (bytes > maximumLineBytes) throw context
          ? new TrafficDumpReadError("traffic_read_limit", "模型流量记录超过 16 MiB 读取上限")
          : new Error("模型流量记录超过 16 MiB 读取上限");
        chunks.push(chunk.subarray(start, end));
        if (newline < 0) break;
        yield Buffer.concat(chunks, bytes).toString("utf8").replace(/\r$/u, "");
        chunks = []; bytes = 0; start = newline + 1;
      }
    }
    if (bytes > 0) yield Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    stream.destroy();
    await closed;
  }
}

async function readTrace(directory, id, offset, limit, maxBytes, output, interaction, context) {
  const items = [];
  let chatDiagnostics;
  let websocketClose;
  let remaining = maxBytes;
  let total = 0;
  for await (const record of traceRecords(directory, context)) {
    if (websocketClose === undefined && interaction?.response?.errorScope === "websocket_client_closed"
      && record?.kind === "websocket_close" && record.peer === "client"
      && Number.isSafeInteger(interaction.request.connection) && record.connection === interaction.request.connection
      && record.ts >= interaction.request.startedAtMs && record.ts <= interaction.response.ts
      && Number.isInteger(record.code) && record.code >= 1000 && record.code <= 4999) {
      websocketClose = { peer: "client", code: record.code, atMs: record.ts };
    }
    if (record?.interaction !== id) continue;
    if (record.kind === "chat_diagnostics" && record.fields && typeof record.fields === "object" && !Array.isArray(record.fields)) {
      chatDiagnostics = { fields: record.fields, truncated: record.truncated === true };
    }
    output?.consume(record);
    if (total >= offset && items.length < limit && remaining > 0) {
      const raw = JSON.stringify(record);
      const buffer = Buffer.from(raw, "utf8");
      const text = buffer.subarray(0, Math.max(0, remaining)).toString("utf8");
      const truncated = buffer.length > remaining;
      remaining -= Math.min(buffer.length, remaining);
      items.push({ atMs: record.ts, kind: record.kind, text, truncated });
    }
    total += 1;
  }
  return {
    items,
    chatDiagnostics,
    websocketClose,
    page: {
      offset,
      total,
      previousOffset: offset === 0 ? null : Math.max(0, offset - limit),
      nextOffset: offset + items.length < total ? offset + items.length : null,
    },
  };
}

function numericSuffix(name) {
  return Number(/-([1-9][0-9]*)\.jsonl$/u.exec(name)?.[1] ?? 0);
}

export class TrafficDumpDebugError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function debugDetail(interaction, limit, context) {
  const request = interaction.request.debug;
  const response = interaction.response?.debug;
  if (request === undefined && response === undefined) return {};
  if (request?.version !== 1 || response !== undefined && response?.version !== 1) throw new TrafficDumpDebugError("traffic_unsupported_version", "不支持的 Relay 调试转储版本");
  const stage = async value => {
    if (!value || !value.headers || typeof value.headers !== "object" || Array.isArray(value.headers) || !value.payload
      || typeof value.headersTruncated !== "boolean"
      || Object.values(value.headers).some(header => typeof header !== "string" && (!Array.isArray(header) || header.some(item => typeof item !== "string")))
      || value.state !== undefined && !["finished", "disconnected", "failed", "not_started"].includes(value.state)) {
      throw new TrafficDumpDebugError("traffic_unavailable", "Relay 调试阶段记录不完整或损坏");
    }
    const body = await readPayload(interaction.directory, value.payload, limit, false, context);
    return { headers: value.headers, headersTruncated: value.headersTruncated, body: body.text, bodyTruncated: body.truncated,
      ...(value.status === undefined ? {} : { status: value.status }), ...(value.state === undefined ? {} : { state: value.state }) };
  };
  if (!Array.isArray(request.transformations) || response !== undefined && !Array.isArray(response.transformations)) throw new TrafficDumpDebugError("traffic_unavailable", "Relay 调试处理标记损坏");
  const transformations = [...request.transformations, ...(response?.transformations ?? [])];
  if (!transformations.every(value => ["headers_filtered", "headers_overridden", "stream_defaulted", "store_defaulted", "provider_routing_pinned", "json_unwrapped"].includes(value))) throw new TrafficDumpDebugError("traffic_unsupported_version", "不支持的 Relay 调试处理标记");
  return { debug: { inbound: await stage(request.inbound), delivered: response ? await stage(response.delivered) : null, transformations } };
}

async function readDirectoryEntries(path, context) {
  await readDirectoryMetadata(path, context);
  const directory = await opendir(path);
  const entries = [];
  // async iterator 自行关闭目录；预算失败/取消也经过 iterator.return 关闭。
  for await (const entry of directory) {
    context.charge("entries");
    await context.checkpoint();
    entries.push(entry);
  }
  await readDirectoryMetadata(path, context);
  return entries;
}

async function fileExists(path, context) {
  await readDirectoryMetadata(dirname(path), context);
  const metadata = await lstat(path).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  context.check();
  return metadata !== undefined;
}

async function openDumpFileAsync(path, context) {
  context.charge("files");
  const parentPath = dirname(path);
  const parent = await readDirectoryMetadata(parentPath, context);
  const before = await lstat(path);
  if (!before.isFile()) throw new Error("模型流量文件类型无效");
  context.check();
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await lstat(path);
    const currentParent = await readDirectoryMetadata(parentPath, context);
    context.check();
    if (!opened.isFile() || !current.isFile() || !currentParent.isDirectory()
      || before.dev !== opened.dev || before.ino !== opened.ino
      || current.dev !== opened.dev || current.ino !== opened.ino
      || parent.dev !== currentParent.dev || parent.ino !== currentParent.ino) {
      throw new Error("模型流量文件在读取时被替换");
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

async function readDirectoryMetadata(path, context) {
  context.check();
  if (context.rootDirectory && resolve(path) !== context.rootDirectory) {
    const root = await lstat(context.rootDirectory);
    const expected = context.directories.get(context.rootDirectory);
    if (!root.isDirectory() || root.dev !== expected.dev || root.ino !== expected.ino) {
      throw new Error("模型流量读取根在读取时被替换");
    }
    context.check();
  }
  const metadata = await lstat(path);
  context.check();
  if (!metadata.isDirectory()) throw new Error("模型流量目录类型无效");
  const key = resolve(path);
  const previous = context.directories.get(key);
  if (previous && (previous.dev !== metadata.dev || previous.ino !== metadata.ino)) throw new Error("模型流量目录在读取时被替换");
  context.directories.set(key, metadata);
  return metadata;
}

async function readFileSliceAsync(path, offset, length, allowUnavailable, context, entireFile = false) {
  let handle;
  try { handle = await openDumpFileAsync(path, context); }
  catch (error) {
    if (allowUnavailable && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    context.check();
    if (entireFile) {
      if (size > length) throw new TrafficDumpReadError("traffic_read_limit", "模型流量 manifest 超过 1 MiB 读取上限");
      length = size;
    }
    if (offset + length > size) {
      if (allowUnavailable) return undefined;
      throw new Error("模型流量正文引用超出文件范围");
    }
    context.charge("bytes", length);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      await context.checkpoint();
      const { bytesRead } = await handle.read(buffer, read, Math.min(65_536, length - read), offset + read);
      context.check();
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buffer.subarray(0, read);
  } finally { await handle.close(); }
}
