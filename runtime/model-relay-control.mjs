import { QueueEventsServer, watchQueueChanges } from "./queue-events.mjs";
import { relayDisplayNameSchema } from "./model-relay-config.mjs";
import { randomUUID } from "node:crypto";
import { PrivateIpcServer, createPrivateIpcConnection, privateIpcEndpointExists } from "./private-ipc.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export class ModelRelayControl {
  #server;
  #events;
  #closed = false;
  constructor(path, handler) {
    this.#events = new QueueEventsServer(`${path}.events`);
    this.#server = new PrivateIpcServer(path, socket => {
      let bytes = 0; const chunks = []; let handled = false;
      const controller = new AbortController();
      socket.on("error", () => {}); socket.once("close", () => controller.abort());
      socket.on("data", chunk => {
        bytes += chunk.length;
        if (handled || bytes > 8192) { socket.destroy(); return; }
        chunks.push(chunk); if (!chunk.includes(10)) return;
        handled = true;
        let request;
        try { request = JSON.parse(Buffer.concat(chunks).toString("utf8").trim()); } catch { socket.destroy(); return; }
        if (!request || Array.isArray(request) || typeof request !== "object" || request.version !== 4
          || typeof request.requestId !== "string" || !uuid.test(request.requestId) || !["apply", "status", "queue"].includes(request.operation)
          || Object.keys(request).some(key => !["version", "requestId", "operation", ...(request.operation === "apply" ? ["digest"] : [])].includes(key))
          || (request.operation === "apply" && (typeof request.digest !== "string" || !/^[a-f0-9]{64}$/u.test(request.digest)))) {
          socket.destroy(); return;
        }
        void Promise.resolve().then(() => {
          if (this.#closed || controller.signal.aborted) throw new Error("Control closed");
          return handler(request, controller.signal);
        }).then(result => {
          if (!this.#closed && !controller.signal.aborted) socket.end(`${JSON.stringify({ version: 4, requestId: request.requestId, ...result })}\n`);
        }, () => { if (!socket.destroyed) socket.end(`${JSON.stringify({ version: 4, requestId: request.requestId, result: "rejected", reason: "unavailable" })}\n`); });
      });
    }, { maximumConnections: 4, connectionTimeoutMs: 2000 });
  }
  async start() {
    await this.#server.start("Model Relay 已在运行");
    try { await this.#events.start(); } catch (error) { await this.#server.close(); throw error; }
  }
  changed() { this.#events.changed(); }
  close() { this.#closed = true; return Promise.all([this.#server.close(), this.#events.close()]).then(() => undefined); }
}

export async function queryModelRelayControl(path, operation, digest) {
  if (!privateIpcEndpointExists(path)) return { result: "not_running" };
  const requestId = randomUUID();
  return new Promise(resolve => {
    let socket; let done = false; let bytes = 0; const chunks = [];
    const finish = result => { if (done) return; done = true; clearTimeout(timer); socket?.destroy(); resolve(result); };
    const timer = setTimeout(() => finish({ result: "unconfirmed" }), 2000);
    try { socket = createPrivateIpcConnection(path); } catch { finish({ result: "unconfirmed" }); return; }
    socket.once("error", () => finish({ result: "unconfirmed" }));
    socket.once("close", () => finish({ result: "unconfirmed" }));
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 4, requestId, operation, ...(digest === undefined ? {} : { digest }) })}\n`));
    socket.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > (operation === "queue" ? 128 * 1024 : 8192)) { finish({ result: "unconfirmed" }); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8").trim());
        if (response.version !== 4 || response.requestId !== requestId
          || (operation === "apply" && (response.result !== "applied" || response.digest !== digest))
          || (operation === "status" && response.result !== "status")
          || (operation === "queue" && response.result !== "queue")) throw new Error("Invalid acknowledgment");
        const keys = operation === "apply" ? ["version", "requestId", "result", "digest"]
          : operation === "queue" ? ["version", "requestId", "result", "configurationValid", "enabled", "listening", "requests"]
          : ["version", "requestId", "result", "configurationValid", "enabled", "listening", "active", "queue", "unavailableAccounts", "metrics", "capture"];
        if (Object.keys(response).some(key => !keys.includes(key))) throw new Error("Invalid acknowledgment");
        if (operation === "queue") {
          if (typeof response.configurationValid !== "boolean" || typeof response.enabled !== "boolean" || typeof response.listening !== "boolean"
            || !Array.isArray(response.requests) || response.requests.length > 64 || response.requests.some(row =>
            !row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 8
            || (row.displayName !== null && !relayDisplayNameSchema.safeParse(row.displayName).success)
            || typeof row.requestId !== "string" || !uuid.test(row.requestId)
            || typeof row.callerId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(row.callerId)
            || typeof row.provider !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(row.provider)
            || (row.model !== null && (typeof row.model !== "string" || row.model.length < 1 || row.model.length > 200))
            || !["chat", "responses"].includes(row.protocol)
            || !["input", "queue", "prepare", "upstream", "delivery"].includes(row.phase)
            || !Number.isSafeInteger(row.elapsedMs) || row.elapsedMs < 0)) throw new Error("Invalid queue snapshot");
        }
        if (operation === "status") {
          if (typeof response.configurationValid !== "boolean" || typeof response.enabled !== "boolean" || typeof response.listening !== "boolean"
            || !Number.isSafeInteger(response.active) || response.active < 0
            || !Number.isSafeInteger(response.unavailableAccounts) || response.unavailableAccounts < 0
            || !response.queue || typeof response.queue !== "object" || Array.isArray(response.queue)
            || Object.keys(response.queue).length !== 5
            || !["pending", "waiting", "bytes", "oldestWaitMs", "timedOut"].every(key => Number.isSafeInteger(response.queue[key]) && response.queue[key] >= 0)
            || response.queue.pending > 32 || response.queue.waiting > response.queue.pending || response.queue.bytes > 16 * 1024 * 1024
            || !response.capture || typeof response.capture !== "object" || Array.isArray(response.capture)
            || Object.keys(response.capture).length !== 4 || typeof response.capture.enabled !== "boolean"
            || !["initializing", "ready", "failed", "closed"].includes(response.capture.state)
            || !["active", "skippedCapacity"].every(key => Number.isSafeInteger(response.capture[key]) && response.capture[key] >= 0)
            || response.capture.active > 32
            || !response.metrics || typeof response.metrics !== "object" || Array.isArray(response.metrics)
            || Object.keys(response.metrics).length !== 7
            || !["local_dropped", "accepted", "rejected", "unconfirmed", "pending", "active", "bytes"].every(key => Number.isSafeInteger(response.metrics[key]) && response.metrics[key] >= 0)) throw new Error("Invalid acknowledgment");
        }
        finish(response);
      } catch { finish({ result: "unconfirmed" }); }
    });
  });
}

export function watchRelayChanges(path, signal, receive) { return watchQueueChanges(`${path}.events`, signal, receive); }
