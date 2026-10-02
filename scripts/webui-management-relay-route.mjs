import { downloadClineRelayCatalog, saveClineRelayCatalog } from "./cline-relay-catalog.mjs";
import { openQueueStream } from "./webui-queue-events.mjs";
import { watchRelayChanges } from "../runtime/model-relay-control.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { locateUserConfig } from "./runtime-config.mjs";
import { relayDisplayNameSchema, relayExtraModelsSchema } from "../runtime/model-relay-config.mjs";
import { z } from "zod";
import { manageModelRelay, readRelayQueue, readRelayManagement, withRelayManagementTransaction } from "./model-relay-management.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";

const identity = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const fields = { name: relayDisplayNameSchema.optional(), reasoning: z.enum(["passthrough", "off"]) };
const mutation = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("models"), provider: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), extraModels: relayExtraModelsSchema.optional(), enabledModels: z.array(z.string().min(1).max(200)).max(256).optional() }),
  z.strictObject({ command: z.literal("issue"), caller: identity, key: identity, provider: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), ...fields }),
  z.strictObject({ command: z.literal("edit"), caller: identity, provider: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u).optional(), ...fields }),
  z.strictObject({ command: z.literal("delete"), caller: identity }),
  z.strictObject({ command: z.literal("rotate"), caller: identity }),
  z.strictObject({ command: z.literal("disable"), caller: identity }),
]);
const envelope = z.strictObject({ input: mutation, revision: z.string().regex(/^[a-f0-9]{64}$/u), confirmationToken: z.string().max(128).optional() });

export async function routeRelayManagement({ environment, maximumBodyBytes, openMetricsStore, path, principalId, request, response, state }) {
  if (path === "/relay/catalog/update" && request.method === "POST") {
    if (new URL(request.url, "http://localhost").search || !z.strictObject({}).safeParse(await readJsonBody(request, maximumBodyBytes)).success) {
      throw new ApiError(400, "relay_invalid", "Cline 目录更新参数无效");
    }
    try { state.audit.assertWritable(); }
    catch { throw new ApiError(503, "management_audit_unavailable", "审计不可用，未更新目录"); }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once("close", cancel);
    const signal = globalThis.AbortSignal.any([controller.signal, globalThis.AbortSignal.timeout(25_000)]);
    try {
      const catalog = await downloadClineRelayCatalog(environment, signal);
      signal.throwIfAborted();
      const result = await withRelayManagementTransaction(environment, async () => {
        signal.throwIfAborted();
        state.audit.assertWritable();
        return { activation: "saved", catalog: saveClineRelayCatalog(catalog, environment) };
      });
      let auditStatus = result.cleanupStatus === "failed" ? "failed" : "recorded";
      try { state.audit.record({ sessionId: principalId, source: "webui", operation: "relay.catalog.update",
        inputFingerprint: fingerprintManagementValue({ commit: catalog.commit }), phase: "completed", resultCode: "saved", recovery: "none" }); }
      catch { auditStatus = "failed"; }
      sendManagementJson(response, 200, { catalog: result.catalog, auditStatus });
    } catch { throw new ApiError(502, "relay_invalid", "Cline 目录下载或保存失败，原目录保留"); }
    finally { response.off("close", cancel); }
    return true;
  }
  if (path === "/relay/queue/events" && request.method === "GET") {
    if (new URL(request.url, "http://localhost").search) throw new ApiError(400, "relay_invalid", "Relay 管理参数无效");
    const { configPath } = locateUserConfig(environment);
    openQueueStream(state, response, (signal, receive) => watchRelayChanges(modelRelayPaths(configPath).control, signal, receive));
    return true;
  }
  if (path === "/relay/queue" && request.method === "GET") {
    sendManagementJson(response, 200, await readRelayQueue(environment)); return true;
  }
  if (path === "/relay" && request.method === "GET") {
    const snapshot = readRelayManagement(environment);
    const status = await manageModelRelay({ command: "status" }, environment);
    const runtime = status.result === "status" ? {
      state: "running", listening: status.listening, configurationValid: status.configurationValid,
      active: status.active, waiting: status.queue.waiting, uploading: status.queue.pending - status.queue.waiting,
      oldestWaitMs: status.queue.oldestWaitMs, queueTimeouts: status.queue.timedOut,
      capture: { enabled: status.capture.enabled, state: status.capture.state, active: status.capture.active, skippedCapacity: status.capture.skippedCapacity },
      metrics: { accepted: status.metrics.accepted, unconfirmed: status.metrics.unconfirmed, rejected: status.metrics.rejected, localDropped: status.metrics.local_dropped },
    } : { state: status.result === "not_running" ? "stopped" : "unknown" };
    const observedAtMs = Date.now();
    const startAtMs = observedAtMs - 24 * 60 * 60 * 1000;
    let usage = null;
    let store;
    try {
      store = openMetricsStore(environment, observedAtMs);
      usage = { observedAtMs, startAtMs, callers: store.relayCallerUsage(
        snapshot.callers.map(caller => ({ callerId: caller.caller_id, keyId: caller.key_id })), startAtMs, observedAtMs,
      ) };
    } catch {
      // 指标不可用不阻断 Key 管理，也不伪造零调用。
    } finally { store?.close(); }
    sendManagementJson(response, 200, { ...snapshot, runtime, usage }); return true;
  }
  if (!["/relay/preview", "/relay/apply"].includes(path) || request.method !== "POST") return false;
  const parsed = envelope.safeParse(await readJsonBody(request, maximumBodyBytes));
  if (!parsed.success) throw new ApiError(400, "relay_invalid", "Relay 管理参数无效");
  const { input, revision, confirmationToken } = parsed.data;
  // Use the same provider transaction as account/catalog edits, then the config lock.
  const payload = await withRelayManagementTransaction(environment, async () => {
    const { preview } = await manageModelRelay(input, environment, { expectedRevision: revision, preview: true });
    const binding = { sessionId: principalId, operation: "relay.write", inputFingerprint: fingerprintManagementValue(input),
      resourceRevision: revision, previewFingerprint: fingerprintManagementValue(preview) };
    if (path === "/relay/preview") {
      const issued = state.confirmations.issue(binding);
      return { preview, confirmationToken: issued.token };
    }
    state.confirmations.consume(confirmationToken, binding);
    try { state.audit.assertWritable(); }
    catch { throw new ApiError(503, "management_audit_unavailable", "审计不可用，未修改 Relay 配置"); }
    const result = await manageModelRelay(input, environment, { expectedRevision: revision });
    let auditStatus = "recorded";
    try {
      state.audit.record({ sessionId: principalId, source: "webui", operation: `relay.${input.command}`, target: input.command === "models" ? input.provider : input.caller,
        inputFingerprint: binding.inputFingerprint, revision, phase: "completed", resultCode: result.activation, recovery: "none" });
    } catch { auditStatus = "failed"; }
    // Saving has already succeeded. Never discard a one-time secret on an audit failure.
    return { activation: result.activation, key: result.key, auditStatus, ...(result.cleanupStatus ? { cleanupStatus: result.cleanupStatus } : {}) };
  });
  sendManagementJson(response, 200, payload);
  return true;
}
