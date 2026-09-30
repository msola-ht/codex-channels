import { dirname, join } from "node:path";
import { z } from "zod";
import { DeliveryJournal, DeliveryError, readDeliveryQueue, readDeliveryPayload } from "../dist/delivery/index.js";
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
  if (path === "/delivery/content" && request.method === "GET") {
    const params = new URL(request.url, "http://localhost").searchParams;
    const parsed = mutation.omit({ confirmationToken: true }).safeParse(Object.fromEntries(params));
    if (!parsed.success || [...params.keys()].length !== new Set(params.keys()).size) throw new ApiError(400, "delivery_invalid", "投递参数无效");
    try {
      const directory = directoryFor(environment);
      const value = await readDeliveryPayload(directory, parsed.data.id);
      if (!value || entryRevision(directory, value.row) !== parsed.data.revision) throw new ApiError(409, "delivery_stale", "记录已变化，请刷新");
      const { event, image } = decodePersistentOutput(value.payload);
      // Explicit display fields only: never expose the owner, raw payload, tool inputs or credentials.
      const text = event.type === "text.completed" ? event.text : event.type === "thread.name" ? event.name : null;
      sendManagementJson(response, 200, { type: event.type, text: text?.slice(0, 20000) ?? null, truncated: (text?.length ?? 0) > 20000,
        threadId: "threadId" in event ? event.threadId ?? null : null, turnId: "turnId" in event ? event.turnId : null,
        status: "status" in event ? event.status : event.type === "operation.updated" ? event.operation.status : null,
        imageFormat: image?.format ?? null });
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
    row = (await readDeliveryQueue(directory, { id })).records[0];
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
  const journal = new DeliveryJournal(directory, { mode: "maintenance" });
  let cleanupStatus = "closed";
  try {
    await journal.ready;
    // Lock acquisition is authoritative: never compete with Gateway or another operator.
    const current = await journal.queueEntry(id);
    if (!retryable(current) || entryRevision(directory, current) !== revision) throw new ApiError(409, "delivery_stale", "投递记录已变化，请刷新后重试");
    if (!(await journal.resolve(id, "retry"))) throw new ApiError(409, "delivery_stale", "投递记录已变化，请刷新后重试");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DeliveryError && error.code === "conflict") throw new ApiError(409, "delivery_busy", "请先停止 Gateway，再确认重试；投递箱正被占用");
    throw new ApiError(503, "delivery_unconfirmed", "无法确认重试结果，请刷新队列核对，不要重复提交");
  } finally {
    // A completed mutation must not be reported as unapplied if cleanup fails.
    await journal.close().catch(() => { cleanupStatus = "unconfirmed"; });
  }
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
  const rows = [];
  try {
    directory = directoryFor(environment);
    for (const entry of entries) rows.push((await readDeliveryQueue(directory, { id: entry.id })).records[0]);
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
  const journal = new DeliveryJournal(directory, { mode: "maintenance" });
  let cleanupStatus = "closed";
  try {
    await journal.ready;
    if (!(await journal.resolveBatch(rows.map(row => ({ id: row.id, revision: row.revision })), action === "retry" ? "retry" : "confirm"))) throw new ApiError(409, "delivery_stale", "记录已变化，请重新选择");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof DeliveryError && error.code === "conflict") throw new ApiError(409, "delivery_busy", "请先停止 Gateway，投递箱正被占用");
    throw new ApiError(503, "delivery_unconfirmed", "处理结果未确认，请核对队列");
  } finally { await journal.close().catch(() => { cleanupStatus = "unconfirmed"; }); }
  let auditStatus = "recorded";
  try { state.audit.record({ sessionId: principalId, source: "webui", operation: binding.operation, target: fingerprintManagementValue(entries.map(entry => entry.id)),
    inputFingerprint: binding.inputFingerprint, revision: binding.resourceRevision, phase: "completed", resultCode: action === "retry" ? "pending" : "ignored", recovery: "none" }); }
  catch { auditStatus = "failed"; }
  sendManagementJson(response, 200, { result: action === "retry" ? "pending" : "ignored", count: rows.length, auditStatus, cleanupStatus });
}
