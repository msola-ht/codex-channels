import { validModelRequestDiagnostics, modelRequestDiagnosticKeys } from "./chat-diagnostics.js";
import type { Socket } from "node:net";
import { requestPrivateIpcJson, PrivateIpcServer } from "../../runtime/private-ipc.mjs";
import type { RelayMetric } from "./relay-metric.js";
import { validRequestTiming } from "../../runtime/request-timing.mjs";

export interface RelayMetricEnvelope { version: 1; providerId: string; relayRequestId: string; sample: RelayMetric }
export type RelayMetricRejection = "invalid_sample" | "unknown_provider" | "queue_full" | "closing" | "unsupported_version";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const identity = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const sampleKeys = [...modelRequestDiagnosticKeys, "traffic", "source", "threadId", "turnId", "relayRequestId", "callerId", "keyId", "credentialGeneration", "provider", "requestModel", "userAgent",
  "responseModel", "responseFormat", "status", "deliveryStatus", "requestStartedAtMs", "responseCompletedAtMs", "totalDurationMs", "firstTokenMs", "responseTimeMs", "generationTiming",
  "httpStatus", "errorCode", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"];

export class RelayMetricsServer {
  private readonly server: PrivateIpcServer;
  private closed = false;
  private activeReceives = 0;
  constructor(path: string, private readonly receive: (sample: RelayMetric, signal: AbortSignal) => RelayMetricRejection | undefined | Promise<RelayMetricRejection | undefined>) {
    this.server = new PrivateIpcServer(path, socket => this.handle(socket), { maximumConnections: 8, connectionTimeoutMs: 1000 });
  }
  start(): Promise<void> { return this.server.start("Relay 指标 IPC 已被占用"); }
  close(): Promise<void> { this.closed = true; return this.server.close(); }
  private handle(socket: Socket): void {
    let bytes = 0; const chunks: Buffer[] = []; let handled = false;
    const controller = new AbortController();
    socket.once("close", () => controller.abort());
    socket.once("end", () => { controller.abort(); socket.destroy(); });
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      if (handled) { socket.destroy(); return; }
      bytes += chunk.length;
      if (bytes > 32 * 1024) { socket.destroy(); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handled = true;
      let envelope: Record<string, unknown>;
      try { envelope = record(JSON.parse(Buffer.concat(chunks).toString("utf8").trim()) as unknown); } catch { socket.destroy(); return; }
      if (typeof envelope.relayRequestId !== "string" || !uuid.test(envelope.relayRequestId)) { socket.destroy(); return; }
      let reason: RelayMetricRejection | undefined;
      if (this.closed) reason = "closing";
      else if (envelope.version !== 1) reason = "unsupported_version";
      else if (Object.keys(envelope).some(key => !["version", "providerId", "relayRequestId", "sample"].includes(key))
        || !validSample(envelope.sample, envelope.providerId, envelope.relayRequestId)) reason = "invalid_sample";
      const reply = (rejection: RelayMetricRejection | undefined): void => {
        if (this.closed || controller.signal.aborted || socket.destroyed) return;
        socket.end(`${JSON.stringify({ version: 1, relayRequestId: envelope.relayRequestId,
          result: rejection ? "rejected" : "accepted", ...(rejection ? { reason: rejection } : {}) })}\n`);
      };
      if (reason) reply(reason);
      else if (this.activeReceives >= 8) reply("queue_full");
      else {
        this.activeReceives++;
        void Promise.resolve().then(() => {
          if (this.closed || controller.signal.aborted) return "closing" as const;
          return this.receive(envelope.sample as RelayMetric, controller.signal);
        }).then(reply, () => reply("queue_full")).finally(() => { this.activeReceives--; });
      }
    });
  }
}

/** No retry. Caller classifies disconnects/timeouts as unconfirmed, never definite loss. */
export function sendRelayMetrics(path: string, envelope: RelayMetricEnvelope, signal: AbortSignal): Promise<unknown> {
  return requestPrivateIpcJson(path, envelope, { timeoutMs: 1000, maximumBytes: 8192, signal });
}

function validSample(value: unknown, provider: unknown, requestId: unknown): value is RelayMetric {
  try {
    const sample = record(value);
    if (Buffer.byteLength(JSON.stringify(sample)) > 16 * 1024 || Object.keys(sample).some(key => !sampleKeys.includes(key))) return false;
    if (!validModelRequestDiagnostics(sample) || !validRequestTiming(sample) || sample.source !== "relay" || sample.threadId !== null || sample.turnId !== null || sample.relayRequestId !== requestId
      || typeof provider !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(provider) || sample.provider !== provider
      || typeof sample.callerId !== "string" || !identity.test(sample.callerId) || typeof sample.keyId !== "string" || !identity.test(sample.keyId)
      || !Number.isSafeInteger(sample.credentialGeneration) || Number(sample.credentialGeneration) < 1
      || !["json", "sse"].includes(String(sample.responseFormat)) || !["completed", "failed", "incomplete"].includes(String(sample.status))
      || !["finished", "disconnected", "failed"].includes(String(sample.deliveryStatus))) return false;
    if (sample.traffic !== undefined) {
      const traffic = record(sample.traffic);
      if (Object.keys(traffic).some(key => !["label", "session", "interaction"].includes(key)) || !["relay.chat", "relay.responses"].includes(String(traffic.label))
        || typeof traffic.session !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-[1-9][0-9]*)?$/u.test(traffic.session)
        || !Number.isSafeInteger(traffic.interaction) || Number(traffic.interaction) < 1) return false;
    }
    if (sample.userAgent !== undefined && (typeof sample.userAgent !== "string" || sample.userAgent.length < 1
      || sample.userAgent.length > 512 || [...sample.userAgent].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))) return false;
    for (const key of ["requestModel", "responseModel", "errorCode"]) {
      const text = sample[key];
      if (text === undefined && key !== "requestModel") continue;
      if (typeof text !== "string" || text.length < 1 || text.length > (key === "requestModel" ? 265 : 200)
        || [...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
        || key === "errorCode" && !/^[a-zA-Z0-9._:/-]+$/u.test(text)) return false;
    }
    for (const key of ["requestStartedAtMs", "responseCompletedAtMs", "totalDurationMs"]) {
      if (typeof sample[key] !== "number" || !Number.isFinite(sample[key]) || Number(sample[key]) < 0) return false;
    }
    for (const key of ["firstTokenMs", "httpStatus", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]) {
      const number = sample[key];
      if (number === undefined) continue;
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0
        || (key !== "firstTokenMs" && !Number.isSafeInteger(number))) return false;
    }
    return true;
  } catch { return false; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metrics frame");
  return value as Record<string, unknown>;
}
