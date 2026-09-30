import { relayDisplayNameSchema } from "../runtime/model-relay-config.mjs";
import { z } from "zod";
import { manageModelRelay, readRelayManagement, withRelayManagementTransaction } from "./model-relay-management.mjs";
import { ApiError, readJsonBody, sendManagementJson } from "./webui-http.mjs";
import { fingerprintManagementValue } from "./management-security.mjs";

const identity = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
const fields = { name: relayDisplayNameSchema.optional(), models: z.array(z.string().min(1).max(200)).min(1).max(64), reasoning: z.enum(["passthrough", "off"]) };
const mutation = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("issue"), caller: identity, key: identity, provider: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u), ...fields }),
  z.strictObject({ command: z.literal("edit"), caller: identity, provider: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u).optional(), ...fields }),
  z.strictObject({ command: z.literal("delete"), caller: identity }),
  z.strictObject({ command: z.literal("rotate"), caller: identity }),
  z.strictObject({ command: z.literal("disable"), caller: identity }),
]);
const envelope = z.strictObject({ input: mutation, revision: z.string().regex(/^[a-f0-9]{64}$/u), confirmationToken: z.string().max(128).optional() });

export async function routeRelayManagement({ environment, maximumBodyBytes, path, principalId, request, response, state }) {
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
    sendManagementJson(response, 200, { ...snapshot, runtime }); return true;
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
