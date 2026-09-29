import type { Socket } from "node:net";
import { createPrivateIpcConnection, PrivateIpcServer } from "../../runtime/private-ipc.mjs";
import type { RelayMetric } from "./relay-metric.js";

export interface RelayMetricEnvelope { version: 1; providerId: string; relayRequestId: string; sample: RelayMetric }
export type RelayMetricRejection = "invalid_sample" | "unknown_provider" | "queue_full" | "closing" | "unsupported_version";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const identity = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const sampleKeys = ["source", "threadId", "turnId", "relayRequestId", "callerId", "keyId", "credentialGeneration", "provider", "requestModel",
  "responseModel", "responseFormat", "status", "deliveryStatus", "requestStartedAtMs", "responseCompletedAtMs", "totalDurationMs", "firstTokenMs",
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
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Relay metrics cancelled")); return; }
    let socket: Socket;
    try { socket = createPrivateIpcConnection(path); } catch { reject(new Error("Relay metrics unavailable")); return; }
    let done = false; let buffer = "";
    const finish = (value: unknown, failed: boolean): void => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener("abort", abort); socket.destroy();
      if (failed) reject(new Error("Relay metrics unconfirmed")); else resolve(value);
    };
    const abort = (): void => finish(undefined, true);
    const timer = setTimeout(abort, 1000);
    signal.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => { if (!done) socket.write(`${JSON.stringify(envelope)}\n`); });
    socket.on("error", abort); socket.once("close", abort);
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 8192) { abort(); return; }
      if (!buffer.includes("\n")) return;
      try { finish(JSON.parse(buffer.trim()) as unknown, false); } catch { abort(); }
    });
  });
}

function validSample(value: unknown, provider: unknown, requestId: unknown): value is RelayMetric {
  try {
    const sample = record(value);
    if (Buffer.byteLength(JSON.stringify(sample)) > 16 * 1024 || Object.keys(sample).some(key => !sampleKeys.includes(key))) return false;
    if (sample.source !== "relay" || sample.threadId !== null || sample.turnId !== null || sample.relayRequestId !== requestId
      || typeof provider !== "string" || !/^clp-[a-z0-9_-]{1,32}$/u.test(provider) || sample.provider !== provider
      || typeof sample.callerId !== "string" || !identity.test(sample.callerId) || typeof sample.keyId !== "string" || !identity.test(sample.keyId)
      || !Number.isSafeInteger(sample.credentialGeneration) || Number(sample.credentialGeneration) < 1
      || !["json", "sse"].includes(String(sample.responseFormat)) || !["completed", "failed", "incomplete"].includes(String(sample.status))
      || !["finished", "disconnected", "failed"].includes(String(sample.deliveryStatus))) return false;
    for (const key of ["requestModel", "responseModel", "errorCode"]) {
      const text = sample[key];
      if (text === undefined && key !== "requestModel") continue;
      if (typeof text !== "string" || text.length < 1 || text.length > 200
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
