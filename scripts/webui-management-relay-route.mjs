import { openQueueStream } from "./webui-queue-events.mjs";
import { watchRelayChanges } from "../runtime/model-relay-control.mjs";
import { modelRelayPaths } from "../runtime/model-relay-paths.mjs";
import { locateUserConfig } from "./runtime-config.mjs";
import { relayDisplayNameSchema, relayKeyModelsSchema, relayModelReasoningMapSchema } from "../runtime/model-relay-config.mjs";
import { z } from "zod";
import { manageModelRelay, readRelayQueue, readRelayManagement, withRelayManagementTransaction } from "./model-relay-management.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";
import { managementSecurityHeaders } from "./management-security.mjs";
import { probeRelayReasoning } from "./relay-reasoning-probe.mjs";

const activeReasoningProbes = new WeakSet();
const reasoningProbe = z.strictObject({ revision: z.string().regex(/^[a-f0-9]{64}$/u), model: z.string().max(265), protocol: z.enum(["chat", "responses"]) });

const identity = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const fields = { name: relayDisplayNameSchema.optional(), reasoning: z.enum(["passthrough", "off"]).optional(), modelReasoning: relayModelReasoningMapSchema.optional() };
const mutation = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("issue"), caller: identity, key: identity, models: relayKeyModelsSchema, ...fields }),
  z.strictObject({ command: z.literal("edit"), caller: identity, models: relayKeyModelsSchema.optional(), ...fields }),
  z.strictObject({ command: z.literal("delete"), caller: identity }),
  z.strictObject({ command: z.literal("rotate"), caller: identity }),
  z.strictObject({ command: z.literal("disable"), caller: identity }),
]).superRefine((input, context) => {
  if (input.reasoning !== undefined && input.modelReasoning !== undefined) {
    context.addIssue({ code: "custom", path: ["modelReasoning"], message: "整把 Key 策略与逐模型思考策略不可同时设置" });
  }
});
const envelope = z.strictObject({ input: mutation, revision: z.string().regex(/^[a-f0-9]{64}$/u), confirmationToken: z.string().max(128).optional() });

async function readForRequest(request, response, read) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.once("aborted", cancel);
  response.once("close", cancel);
  if (request.aborted || response.destroyed) cancel();
  try {
    controller.signal.throwIfAborted();
    const result = await read(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    request.off("aborted", cancel);
    response.off("close", cancel);
  }
}

export async function routeRelayManagement({ environment, maximumBodyBytes, openMetricsStore, path, principalId, request, response, state }) {
  if (path === "/relay/reasoning-probe" && request.method === "POST") {
    if (new URL(request.url, "http://localhost").search) throw new ApiError(400, "relay_probe_invalid", "Relay 思考探测参数无效");
    let body;
    try { body = await readJsonBody(request, maximumBodyBytes); }
    catch { throw new ApiError(400, "relay_probe_invalid", "Relay 思考探测参数无效"); }
    const parsed = reasoningProbe.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "relay_probe_invalid", "Relay 思考探测参数无效");
    if (activeReasoningProbes.has(state)) throw new ApiError(409, "relay_probe_busy", "已有 Relay 思考探测正在运行");
    activeReasoningProbes.add(state);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const timer = setTimeout(cancel, 140_000);
    response.once("close", cancel);
    request.once("aborted", cancel);
    if (request.aborted || response.destroyed) cancel();
    let writtenBytes = 0;
    const send = async (event, signal = controller.signal) => {
      signal.throwIfAborted();
      controller.signal.throwIfAborted();
      const line = `${JSON.stringify(event)}\n`;
      const bytes = Buffer.byteLength(line);
      // Keep enough room for the fixed terminal error, even after a large snapshot.
      if (bytes > 64 * 1024 || writtenBytes + bytes > 256 * 1024 - (event.type === "error" ? 0 : 128)) throw new Error("Relay probe stream capacity exceeded");
      if (!response.headersSent) {
        response.writeHead(200, { ...managementSecurityHeaders(), "content-type": "application/x-ndjson; charset=utf-8", "x-accel-buffering": "no" });
        response.flushHeaders();
      }
      writtenBytes += bytes;
      if (response.write(line)) return;
      await new Promise((resolve, reject) => {
        const finish = error => {
          response.off("drain", drain);
          response.off("error", fail);
          signal.removeEventListener("abort", aborted);
          controller.signal.removeEventListener("abort", aborted);
          if (error) reject(error);
          else resolve();
        };
        const drain = () => finish();
        const fail = () => finish(new Error("Relay probe stream closed"));
        const aborted = () => finish(new Error("Relay probe stream cancelled"));
        response.once("drain", drain);
        response.once("error", fail);
        signal.addEventListener("abort", aborted, { once: true });
        controller.signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted || controller.signal.aborted || response.destroyed) aborted();
      });
    };
    try {
      const result = await probeRelayReasoning(parsed.data, { environment, signal: controller.signal, onProgress: send });
      await send({ type: "result", result });
      response.end();
    } catch (error) {
      if (!response.headersSent) throw error;
      if (!controller.signal.aborted && !response.destroyed) {
        try { await send({ type: "error", code: "relay_probe_failed" }); response.end(); }
        catch { response.destroy(); }
      } else response.destroy();
    } finally {
      clearTimeout(timer);
      controller.abort();
      response.off("close", cancel);
      request.off("aborted", cancel);
      activeReasoningProbes.delete(state);
    }
    return true;
  }
  if (path === "/relay/queue/events" && request.method === "GET") {
    if (new URL(request.url, "http://localhost").search) throw new ApiError(400, "relay_invalid", "Relay 管理参数无效");
    const { configPath } = locateUserConfig(environment);
    openQueueStream(state, response, (signal, receive) => watchRelayChanges(modelRelayPaths(configPath).control, signal, receive));
    return true;
  }
  if (path === "/relay/queue" && request.method === "GET") {
    const queue = await readForRequest(request, response, signal => readRelayQueue(environment, { signal }));
    sendManagementJson(response, 200, queue); return true;
  }
  if (path === "/relay" && request.method === "GET") {
    const snapshot = readRelayManagement(environment);
    const status = await readForRequest(request, response, signal => manageModelRelay({ command: "status" }, environment, { signal }));
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
      state.audit.record({ sessionId: principalId, source: "webui", operation: `relay.${input.command}`, target: input.caller,
        inputFingerprint: binding.inputFingerprint, revision, phase: "completed", resultCode: result.activation, recovery: "none" });
    } catch { auditStatus = "failed"; }
    // Saving has already succeeded. Never discard a one-time secret on an audit failure.
    return { activation: result.activation, key: result.key, auditStatus, ...(result.cleanupStatus ? { cleanupStatus: result.cleanupStatus } : {}) };
  });
  sendManagementJson(response, 200, payload);
  return true;
}
