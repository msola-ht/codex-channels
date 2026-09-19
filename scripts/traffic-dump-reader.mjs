import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { createOutputCollector, parameterComparison, requestContent, requestMetadata, requestParameters, responseFacts } from "./traffic-dump-presentation.mjs";

const manifestName = "manifest.json";
const interactionFileName = "interactions.jsonl";
const legacyDumpFilePattern = /^[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[1-9]\d*\.jsonl$/u;

export function listDumpFiles(directory) {
  return dumpCatalog(directory).files;
}

export function dumpCatalog(directory) {
  if (!existsSync(directory)) return { files: [], labels: [], sessions: [], legacyFiles: [] };
  const sessions = [];
  const legacyFiles = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isFile() && legacyDumpFilePattern.test(entry.name)) {
      legacyFiles.push(path);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const manifest = readManifest(path);
    if (manifest === undefined) continue;
    if (manifest.version !== 2) {
      throw new Error(`不支持的模型流量转储版本：${manifest.version}`);
    }
    sessions.push({ path, ...manifest });
  }
  sessions.sort((left, right) => left.createdAtMs - right.createdAtMs);
  const labels = [...new Set(sessions.map((entry) => entry.label))]
    .map((label) => {
      const own = sessions.filter((entry) => entry.label === label);
      return {
        label,
        sessions: own.length,
        latestAtMs: Math.max(...own.map((entry) => entry.createdAtMs)),
      };
    })
    .sort((left, right) => right.latestAtMs - left.latestAtMs
      || (left.label < right.label ? -1 : left.label > right.label ? 1 : 0));
  return {
    files: sessions.map((entry) => entry.path), labels, legacyFiles,
    sessions: sessions.map(({ label, session, createdAtMs }) => ({ label, session, createdAtMs })),
  };
}

export function labelOf(path) {
  return readManifest(sessionDirectoryOf(path))?.label;
}

export function writerSessionOf(path) {
  return readManifest(sessionDirectoryOf(path))?.session;
}

export function selectFilesOfLabel(paths, label, requestedSession) {
  return paths.filter((path) => {
    const manifest = readManifest(sessionDirectoryOf(path));
    return manifest?.label === label
      && (requestedSession === undefined || manifest.session === requestedSession);
  });
}

export async function forEachDumpRecord(paths, visit) {
  for (const directory of sessionDirectories(paths)) {
    const path = join(directory, interactionFileName);
    if (!existsSync(path)) continue;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    let pendingLine;
    for await (const line of lines) {
      if (line.length === 0) continue;
      if (pendingLine !== undefined) await visitIndexLine(pendingLine, directory, visit, false);
      pendingLine = line;
    }
    if (pendingLine !== undefined) await visitIndexLine(pendingLine, directory, visit, true);
  }
}

export async function summarizeDumpFiles(paths, { limit, offset = 0, newestFirst = false } = {}) {
  const page = limit === undefined
    ? await readAllInteractionSummaries(paths, newestFirst)
    : await readInteractionSummaryPage(paths, offset + limit, newestFirst);
  const boundedLimit = limit ?? page.entries.length;
  const exchanges = page.entries.slice(offset, offset + boundedLimit).map((entry) => {
    const body = entry.request.transport === "websocket"
      && (entry.request.requestKind === undefined || entry.request.requestKind === "prewarm")
      ? parseJson(readPayload(entry.directory, entry.request.payload, 4 * 1_048_576).text)
      : undefined;
    return summaryOf(entry, body);
  });
  return {
    exchanges,
    total: page.total,
    nextOffset: offset + exchanges.length < page.total ? offset + exchanges.length : null,
  };
}

export async function readDumpExchange(paths, id) {
  if (sessionDirectories(paths).length !== 1) {
    throw new Error("读取模型调用明细必须指定一个 V2 session");
  }
  const directory = sessionDirectories(paths)[0];
  let interaction;
  await forEachDumpRecord(paths, (record, recordDirectory) => {
    if ((record.kind !== "request" && record.kind !== "response") || record.id !== id) return;
    interaction ??= { directory: recordDirectory, session: writerSessionOf(directory) };
    interaction[record.kind] = record;
  });
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
  { traceOffset = 0, maxTracePageSize = 100, maxSectionBytes = 4 * 1_048_576 } = {},
) {
  const interaction = await readDumpExchange(paths, id);
  if (interaction?.request === undefined) return null;
  const directory = interaction.directory;
  const requestPayload = readPayload(directory, interaction.request.payload, maxSectionBytes);
  const responsePayload = readPayload(directory, interaction.response?.payload, maxSectionBytes);
  const requestBody = parseJson(requestPayload.text);
  const responseBody = parseJson(responsePayload.text);
  const facts = responseFacts(responseBody);
  const output = createOutputCollector(maxSectionBytes, (responseBody?.response ?? responseBody)?.output, facts.responseId);
  const trace = await readTrace(directory, id, traceOffset, maxTracePageSize, maxSectionBytes, output);
  return {
    ...summaryOf(interaction, requestBody),
    parameterComparison: parameterComparison(requestBody, responseBody),
    request: {
      headers: interaction.request.headers ?? {},
      method: interaction.request.method,
      path: interaction.request.path,
      url: interaction.request.url,
      body: requestPayload.text,
      bodyTruncated: requestPayload.truncated,
      bytes: interaction.request.bytes ?? interaction.request.payload?.bytes,
      storedBytes: interaction.request.payload?.bytes,
      parameters: requestParameters(requestBody),
      content: requestContent(requestBody),
    },
    response: interaction.response === undefined ? null : {
      state: interaction.response.state,
      status: interaction.response.status ?? null,
      headers: interaction.response.headers ?? {},
      body: responsePayload.text,
      bodyTruncated: responsePayload.truncated,
      bytes: interaction.response.bytes ?? interaction.response.payload?.bytes,
      durationMs: interaction.response.durationMs,
      firstContentMs: interaction.response.firstContentMs,
      httpTiming: interaction.request.transport !== "http" ? null : {
        receiveRequestMs: elapsedMs(interaction.request.startedAtMs, trace.milestones.request_end),
        waitResponseHeadMs: elapsedMs(trace.milestones.request_end, trace.milestones.response_head),
        receiveResponseMs: elapsedMs(trace.milestones.response_head, trace.milestones.response_end),
      },
      eventType: interaction.response.eventType,
      errorScope: interaction.response.errorScope,
      error: interaction.response.error,
      storedBytes: interaction.response.payload?.bytes,
      ...facts,
      ...output.result(),
    },
    trace: trace.items,
    tracePage: trace.page,
  };
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

export function formatTime(atMs) {
  return Number.isFinite(atMs) ? new Date(atMs).toLocaleString("zh-CN", { hour12: false }) : "-";
}

function readManifest(directory) {
  const path = join(directory, manifestName);
  if (!existsSync(path)) return undefined;
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`模型流量 manifest 无效：${directory}`);
  }
  if (typeof value !== "object" || value === null
    || typeof value.createdAtMs !== "number" || !Number.isFinite(value.createdAtMs)
    || typeof value.label !== "string" || value.label.length === 0
    || typeof value.session !== "string" || value.session.length === 0
    || typeof value.version !== "number" || !Number.isFinite(value.version)) {
    throw new Error(`模型流量 manifest 无效：${directory}`);
  }
  return value;
}

async function visitIndexLine(line, directory, visit, allowTornTail) {
  const record = parseJson(line);
  if (record === undefined && allowTornTail) return;
  if (record?.version !== 2) {
    throw new Error(`不支持的模型流量索引版本：${record?.version ?? "缺失"}`);
  }
  await visit(record, directory);
}

function sessionDirectoryOf(path) {
  const resolved = resolve(path);
  const stats = statSync(resolved, { throwIfNoEntry: false });
  return stats?.isDirectory() || basename(resolved) !== interactionFileName
    ? resolved
    : resolve(resolved, "..");
}

function sessionDirectories(paths) {
  return [...new Set(paths.map(sessionDirectoryOf))];
}

async function readInteractions(paths) {
  const interactions = new Map();
  const sessions = new Map(sessionDirectories(paths).map((directory) => [directory, writerSessionOf(directory)]));
  await forEachDumpRecord(paths, (record, directory) => {
    if (record.kind !== "request" && record.kind !== "response") return;
    if (!Number.isSafeInteger(record.id) || record.id < 1) return;
    const key = join(directory, String(record.id));
    const entry = interactions.get(key) ?? { directory, session: sessions.get(directory) };
    entry[record.kind] = record;
    interactions.set(key, entry);
  });
  return interactions;
}

async function readAllInteractionSummaries(paths, newestFirst) {
  const interactions = await readInteractions(paths);
  const entries = [...interactions.values()]
    .filter((entry) => entry.request !== undefined)
    .sort((left, right) => compareInteraction(left, right, newestFirst));
  return { entries, total: entries.length };
}

/** 只保留当前页之前的候选；响应通过 session + id 回填，不缓存页外调用。 */
async function readInteractionSummaryPage(paths, maximumEntries, newestFirst) {
  const entries = [];
  const selected = new Map();
  const compare = (left, right) => compareInteraction(left, right, newestFirst);
  const sessions = new Map(sessionDirectories(paths)
    .map((directory) => [directory, writerSessionOf(directory)]));
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
  });
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

function summaryOf(interaction, body) {
  const request = interaction.request;
  const response = interaction.response;
  const metadata = requestMetadata(body);
  const requestKind = metadata.requestKind ?? (body?.generate === false ? "prewarm" : request.requestKind);
  return {
    id: request.id,
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
    ...(requestKind === undefined ? {} : { requestKind }),
    category: request.method === "GET" && request.path?.split("?")[0] === "/models"
      ? "models" : requestKind === "prewarm" ? "prewarm" : "model",
    responseModels: response?.responseModels ?? [],
    state: response?.state ?? "pending",
    status: response?.status,
    durationMs: response?.durationMs,
    hasError: response?.state === "failed" || response?.state === "incomplete",
  };
}

function readPayload(directory, payload, maxBytes) {
  if (payload === undefined || !Array.isArray(payload.parts)) return { text: "", truncated: false };
  const buffers = [];
  let remaining = maxBytes;
  let truncated = false;
  for (const part of payload.parts) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    assertPayloadPart(part);
    const length = Math.min(part.bytes, remaining);
    const buffer = readFileSlice(join(directory, part.file), part.offset, length);
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

function readFileSlice(path, offset, length) {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (offset + length > size) throw new Error("模型流量正文引用超出文件范围");
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

async function readTrace(directory, id, offset, limit, maxBytes, output) {
  const items = [];
  const milestones = {};
  let remaining = maxBytes;
  let total = 0;
  const paths = readdirSync(directory)
    .filter((name) => /^trace-[1-9][0-9]*\.jsonl$/u.test(name))
    .sort((left, right) => numericSuffix(left) - numericSuffix(right));
  for (const path of paths) {
    const lines = createInterface({ input: createReadStream(join(directory, path)), crlfDelay: Infinity });
    for await (const line of lines) {
      const record = parseJson(line);
      if (record?.interaction !== id) continue;
      if (["request_end", "response_head", "response_end"].includes(record.kind)) {
        milestones[record.kind] = record.ts;
      }
      output.consume(record);
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
  }
  return {
    items,
    milestones,
    page: {
      offset,
      total,
      previousOffset: offset === 0 ? null : Math.max(0, offset - limit),
      nextOffset: offset + items.length < total ? offset + items.length : null,
    },
  };
}

function elapsedMs(start, end) {
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : undefined;
}

function numericSuffix(name) {
  return Number(/-([1-9][0-9]*)\.jsonl$/u.exec(name)?.[1] ?? 0);
}
