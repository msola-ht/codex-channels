import { randomUUID } from "node:crypto";
import { PrivateIpcServer, createPrivateIpcConnection, privateIpcEndpointExists } from "./private-ipc.mjs";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export class ModelRelayControl {
  #server;
  #closed = false;
  constructor(path, handler) {
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
        if (!request || Array.isArray(request) || typeof request !== "object" || request.version !== 1
          || typeof request.requestId !== "string" || !uuid.test(request.requestId) || !["apply", "status"].includes(request.operation)
          || Object.keys(request).some(key => !["version", "requestId", "operation", ...(request.operation === "apply" ? ["digest"] : [])].includes(key))
          || (request.operation === "apply" && (typeof request.digest !== "string" || !/^[a-f0-9]{64}$/u.test(request.digest)))) {
          socket.destroy(); return;
        }
        void Promise.resolve().then(() => {
          if (this.#closed || controller.signal.aborted) throw new Error("Control closed");
          return handler(request, controller.signal);
        }).then(result => {
          if (!this.#closed && !controller.signal.aborted) socket.end(`${JSON.stringify({ version: 1, requestId: request.requestId, ...result })}\n`);
        }, () => { if (!socket.destroyed) socket.end(`${JSON.stringify({ version: 1, requestId: request.requestId, result: "rejected", reason: "unavailable" })}\n`); });
      });
    }, { maximumConnections: 4, connectionTimeoutMs: 2000 });
  }
  start() { return this.#server.start("Model Relay 已在运行"); }
  close() { this.#closed = true; return this.#server.close(); }
}

export async function queryModelRelayControl(path, operation, digest) {
  if (!privateIpcEndpointExists(path)) return { result: "not_running" };
  const requestId = randomUUID();
  return new Promise(resolve => {
    let socket; let done = false; let bytes = "";
    const finish = result => { if (done) return; done = true; clearTimeout(timer); socket?.destroy(); resolve(result); };
    const timer = setTimeout(() => finish({ result: "unconfirmed" }), 2000);
    try { socket = createPrivateIpcConnection(path); } catch { finish({ result: "unconfirmed" }); return; }
    socket.once("error", () => finish({ result: "unconfirmed" }));
    socket.once("close", () => finish({ result: "unconfirmed" }));
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, requestId, operation, ...(digest === undefined ? {} : { digest }) })}\n`));
    socket.on("data", chunk => {
      bytes += chunk.toString("utf8");
      if (Buffer.byteLength(bytes) > 8192) { finish({ result: "unconfirmed" }); return; }
      if (!bytes.includes("\n")) return;
      try {
        const response = JSON.parse(bytes.trim());
        if (response.version !== 1 || response.requestId !== requestId
          || (operation === "apply" && (response.result !== "applied" || response.digest !== digest))
          || (operation === "status" && response.result !== "status")) throw new Error("Invalid acknowledgment");
        const keys = operation === "apply" ? ["version", "requestId", "result", "digest"]
          : ["version", "requestId", "result", "configurationValid", "enabled", "listening", "active", "unavailableAccounts", "metrics"];
        if (Object.keys(response).some(key => !keys.includes(key))) throw new Error("Invalid acknowledgment");
        if (operation === "status") {
          if (typeof response.configurationValid !== "boolean" || typeof response.enabled !== "boolean" || typeof response.listening !== "boolean"
            || !Number.isSafeInteger(response.active) || response.active < 0
            || !Number.isSafeInteger(response.unavailableAccounts) || response.unavailableAccounts < 0
            || !response.metrics || typeof response.metrics !== "object" || Array.isArray(response.metrics)
            || Object.keys(response.metrics).length !== 7
            || !["local_dropped", "accepted", "rejected", "unconfirmed", "pending", "active", "bytes"].every(key => Number.isSafeInteger(response.metrics[key]) && response.metrics[key] >= 0)) throw new Error("Invalid acknowledgment");
        }
        finish(response);
      } catch { finish({ result: "unconfirmed" }); }
    });
  });
}
