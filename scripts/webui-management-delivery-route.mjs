import { openQueueStream } from "./webui-queue-events.mjs";
import { requestDeliveryResolution, watchDeliveryChanges } from "../runtime/delivery-control.mjs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DeliveryJournal, DeliveryError, readDeliveryQueue, readDeliveryPayload, readDeliveryEntries, readDeliveryPayloads } from "../dist/delivery/index.js";
import { decodePersistentOutput } from "../dist/surfaces/delivery-diagnostics/index.js";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { locateUserConfig, resolveConfiguredPath } from "./runtime-config.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";

const mutation = z.strictObject({ id: z.string().min(1).max(4096), revision: z.string().regex(/^[a-f0-9]{64}$/u),
  confirmationToken: z.string().max(128).optional() });
const query = z.strictObject({ before: z.string().regex(/^(0|[1-9][0-9]*)$/u).transform(Number).pipe(z.number().int().nonnegative().safe()).optional(),
  state: z.enum(["pending", "sending", "uncertain", "blocked"]).optional() });

function directoryFor(environment) {
  const { configPath, dataDir } = locateUserConfig(environment);
  const config = readGatewayConfig(configPath);
  return join(dirname(resolveConfiguredPath(config.storage?.database_path, dataDir, "data/gateway.sqlite3")), "delivery-outbox");
}
function entryRevision(directory, row) { return fingerprintManagementValue({ directory, row }); }
function retryable(row) { return row && ["uncertain", "blocked"].includes(row.state); }

export async function routeDeliveryManagement({ environment, maximumBodyBytes, path, principalId, request, response, state }) {
  if (path === "/delivery/events" && request.method === "GET") {
    if (new URL(request.url, "http://localhost").search) throw new ApiError(400, "delivery_invalid", "投递参数无效");
    const directory = directoryFor(environment);
    openQueueStream(state, response, (signal, receive) => watchDeliveryChanges(directory, signal, receive));
    return true;
  }
  if (path === "/delivery/content-batch" && request.method === "POST") {
    const parsed = z.strictObject({ entries: batchMutation.shape.entries }).safeParse(await readJsonBody(request, maximumBodyBytes));
    if (!parsed.success || new Set(parsed.data.entries.map(entry => entry.id)).size !== parsed.data.entries.length) throw new ApiError(400, "delivery_invalid", "投递参数无效");
    try {
      const directory = directoryFor(environment);
      const entries = parsed.data.entries;
      const revisions = new Map(entries.map(entry => [entry.id, entry.revision]));
      const contents = await readDeliveryPayloads(directory, entries.map(entry => entry.id), (row, payload) => {
        if (entryRevision(directory, row) !== revisions.get(row.id)) return null;
        return displayContent(payload, 160);
      });
      sendManagementJson(response, 200, { records: entries.map((entry, index) => ({ ...entry, content: contents[index] })) });
    } catch { throw new ApiError(503, "delivery_unavailable", "投递内容暂不可读取"); }
    return true;
  }
  if (path === "/delivery/content" && request.method === "GET") {
    const params = new URL(request.url, "http://localhost").searchParams;
    const parsed = mutation.omit({ confirmationToken: true }).safeParse(Object.fromEntries(params));
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size) throw new ApiError(400, "delivery_invalid", "投递参数无效");
    try {
      const directory = directoryFor(environment);
      const value = await readDeliveryPayload(directory, parsed.data.id);
      if (!value || entryRevision(directory, value.row) !== parsed.data.revision) throw new ApiError(409, "delivery_stale", "记录已变化，请刷新");
      sendManagementJson(response, 200, displayContent(value.payload, 20000));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, "delivery_unavailable", "投递内容暂不可读取");
    }
    return true;
  }
  if (path === "/delivery/queue" && request.method === "GET") {
    const params = new URL(request.url, "http://localhost").searchParams;
    const parsed = query.safeParse(Object.fromEntries(params));
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size) throw new ApiError(400, "delivery_invalid", "投递队列参数无效");
    try {
      const directory = directoryFor(environment);
      const snapshot = await readDeliveryQueue(directory, parsed.data);
      sendManagementJson(response, 200, { ...snapshot, records: snapshot.records.map(row => ({ ...row, revision: entryRevision(directory, row) })) });
    } catch { throw new ApiError(503, "delivery_unavailable", "投递队列暂不可读取"); }
    return true;
  }
  if (["/delivery/batch-preview", "/delivery/batch-apply"].includes(path) && request.method === "POST") {
    await batchDelivery({ environment, maximumBodyBytes, path, principalId, request, response, state });
    return true;
  }
  if (!["/delivery/preview", "/delivery/retry"].includes(path) || request.method !== "POST") return false;
  const parsed = mutation.safeParse(await readJsonBody(request, maximumBodyBytes));
  if (!parsed.success) throw new ApiError(400, "delivery_invalid", "投递重试参数无效");
  const { id, revision, confirmationToken } = parsed.data;
  let directory, row;
  try {
    directory = directoryFor(environment);
    row = (await readDeliveryEntries(directory, [id]))[0];
  } catch { throw new ApiError(503, "delivery_unavailable", "投递队列暂不可读取"); }
  if (!retryable(row) || entryRevision(directory, row) !== revision) throw new ApiError(409, "delivery_stale", "投递记录已变化，请刷新后重试");
  const binding = { sessionId: principalId, operation: "delivery.retry", inputFingerprint: fingerprintManagementValue({ id, revision }),
    resourceRevision: revision, previewFingerprint: fingerprintManagementValue(row) };
  if (path === "/delivery/preview") {
    const issued = state.confirmations.issue(binding);
    sendManagementJson(response, 200, { preview: { ...row, revision }, confirmationToken: issued.token });
    return true;
  }
  state.confirmations.consume(confirmationToken, binding);
  try { state.audit.assertWritable(); }
  catch { throw new ApiError(503, "management_audit_unavailable", "审计不可用，未重试投递"); }
  const cleanupStatus = await resolveDelivery(directory, [row], "retry");
  let auditStatus = "recorded";
  try {
    state.audit.record({ sessionId: principalId, source: "webui", operation: "delivery.retry", target: fingerprintManagementValue(id),
      inputFingerprint: binding.inputFingerprint, revision, phase: "completed", resultCode: "pending", recovery: "none" });
  } catch { auditStatus = "failed"; }
  sendManagementJson(response, 200, { result: "pending", auditStatus, cleanupStatus });
  return true;
}

const batchMutation = z.strictObject({
  action: z.enum(["retry", "ignore"]),
  entries: z.array(z.strictObject({ id: z.string().min(1).max(4096), revision: z.string().regex(/^[a-f0-9]{64}$/u) })).min(1).max(50),
  confirmationToken: z.string().max(128).optional(),
});
async function batchDelivery({ environment, maximumBodyBytes, path, principalId, request, response, state }) {
  const parsed = batchMutation.safeParse(await readJsonBody(request, maximumBodyBytes));
  if (!parsed.success || new Set(parsed.data.entries.map(entry => entry.id)).size !== parsed.data.entries.length) throw new ApiError(400, "delivery_invalid", "投递处理参数无效");
  const { action, entries, confirmationToken } = parsed.data;
  let directory;
  let rows;
  try {
    directory = directoryFor(environment);
    rows = await readDeliveryEntries(directory, entries.map(entry => entry.id));
  } catch { throw new ApiError(503, "delivery_unavailable", "投递队列暂不可读取"); }
  if (rows.some((row, index) => !retryable(row) || entryRevision(directory, row) !== entries[index].revision)) throw new ApiError(409, "delivery_stale", "记录已变化，请重新选择");
  const binding = { sessionId: principalId, operation: `delivery.batch.${action}`, inputFingerprint: fingerprintManagementValue({ action, entries }),
    resourceRevision: fingerprintManagementValue({ directory, rows }), previewFingerprint: fingerprintManagementValue(rows) };
  if (path === "/delivery/batch-preview") {
    sendManagementJson(response, 200, { preview: { action, count: rows.length }, confirmationToken: state.confirmations.issue(binding).token });
    return;
  }
  state.confirmations.consume(confirmationToken, binding);
  try { state.audit.assertWritable(); }
  catch { throw new ApiError(503, "management_audit_unavailable", "审计不可用，未处理投递"); }
  const cleanupStatus = await resolveDelivery(directory, rows, action);
  let auditStatus = "recorded";
  try { state.audit.record({ sessionId: principalId, source: "webui", operation: binding.operation, target: fingerprintManagementValue(entries.map(entry => entry.id)),
    inputFingerprint: binding.inputFingerprint, revision: binding.resourceRevision, phase: "completed", resultCode: action === "retry" ? "pending" : "ignored", recovery: "none" }); }
  catch { auditStatus = "failed"; }
  sendManagementJson(response, 200, { result: action === "retry" ? "pending" : "ignored", count: rows.length, auditStatus, cleanupStatus });
}

function displayContent(payload, limit) {
  const { event, image } = decodePersistentOutput(payload);
  const text = event.type === "text.completed" ? event.text : event.type === "thread.name" ? event.name : null;
  return { type: event.type, text: text?.slice(0, limit) ?? null, truncated: (text?.length ?? 0) > limit,
    threadId: "threadId" in event ? event.threadId ?? null : null, turnId: "turnId" in event ? event.turnId : null,
    status: "status" in event ? event.status : event.type === "operation.updated" ? event.operation.status : null,
    imageFormat: image?.format ?? null };
}

async function resolveDelivery(directory, rows, action) {
  const entries = rows.map(row => ({ id: row.id, revision: row.revision }));
  let result;
  try { result = await requestDeliveryResolution(directory, entries, action); }
  catch { throw new ApiError(503, "delivery_unconfirmed", "无法确认处理结果，请刷新核对"); }
  if (result === "applied") return "closed";
  if (result === "stale") throw new ApiError(409, "delivery_stale", "记录已变化，请刷新后重试");
  if (result === "busy") throw new ApiError(409, "delivery_busy", "目标会话正在投递，请稍后重试");
  if (result !== null) throw new ApiError(503, "delivery_unconfirmed", "处理结果未确认，请核对队列，不要重复提交");
  // Fallback only when no IPC command was sent; the writer lock remains authoritative.
  const journal = new DeliveryJournal(directory, { mode: "maintenance" });
  let cleanupStatus = "closed";
  try {
    await journal.ready;
    if (!(await journal.resolveBatch(entries, action === "retry" ? "retry" : "confirm"))) throw new ApiError(409, "delivery_stale", "记录已变化，请重新选择");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DeliveryError && error.code === "conflict") throw new ApiError(409, "delivery_busy", "投递正在处理或运行中的 Gateway 尚不支持在线管理，请稍后重试或升级 Gateway");
    throw new ApiError(503, "delivery_unconfirmed", "处理结果未确认，请核对队列");
  } finally { await journal.close().catch(() => { cleanupStatus = "unconfirmed"; }); }
  return cleanupStatus;
}
