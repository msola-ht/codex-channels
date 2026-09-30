import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { z } from "zod";
import { PrivateIpcServer, createPrivateIpcConnection } from "./private-ipc.mjs";

const entry = z.strictObject({ id: z.string().min(1).max(4096), revision: z.string().regex(/^[a-f0-9]{64}$/u) });
const requestSchema = z.strictObject({ version: z.literal(1), action: z.enum(["retry", "ignore"]),
  entries: z.array(entry).min(1).max(50).refine(values => new Set(values.map(value => value.id)).size === values.length) });
const responseSchema = z.strictObject({ version: z.literal(1), result: z.enum(["applied", "stale", "busy", "unconfirmed"]) });
const timeoutMs = 20_000;
const maximumBytes = 256 * 1024;
export function deliveryControlSocketPath(directory) {
  if (process.platform === "win32") return join(directory, "control.sock");
  const canonical = realpathSync(directory);
  return join(realpathSync("/tmp"), `cdc-${process.getuid()}`, createHash("sha256").update(canonical).digest("hex"));
}

function validateParent(path, create = false) {
  if (process.platform === "win32") return;
  const parent = dirname(path);
  if (create) {
    try { mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe delivery control directory");
}

/** A single bounded frame per connection; never forward internal exception text. */
function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error, value) => {
      socket.removeListener("data", data);
      socket.removeListener("error", failed);
      socket.removeListener("close", failed);
      socket.removeListener("end", failed);
      if (error) reject(error); else resolve(value);
    };
    const failed = () => finish(new Error("Delivery control connection closed"));
    const data = chunk => {
      if (bytes.length + chunk.length > maximumBytes) { finish(new Error("Delivery control frame too large")); return; }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      try {
        if (bytes.subarray(newline + 1).toString().trim()) throw new Error("Invalid frame");
        const value = JSON.parse(bytes.subarray(0, newline).toString());
        finish(null, value);
      } catch { finish(new Error("Invalid delivery control frame")); }
    };
    socket.on("data", data);
    socket.once("error", failed);
    socket.once("close", failed);
    socket.once("end", failed);
  });
}

export class DeliveryControlServer {
  #server;
  #events;
  #subscribers = new Set();
  #notification;
  #closed = false;
  #directory;
  #resolve;
  constructor(directory, resolve) { this.#directory = directory; this.#resolve = resolve; }
  async start() {
    const path = deliveryControlSocketPath(this.#directory);
    validateParent(path, true);
    this.#server = new PrivateIpcServer(path, socket => {
      socket.on("error", () => {});
      void readFrame(socket).then(async value => {
        const request = requestSchema.parse(value);
        if (this.#closed || socket.destroyed) return "unconfirmed";
        try { return await this.#resolve(request.entries, request.action) ? "applied" : "stale"; }
        catch (error) { return error?.code === "conflict" ? "busy" : "unconfirmed"; }
      }).catch(() => "unconfirmed").then(result => {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ version: 1, result })}\n`);
      });
    }, { maximumConnections: 8, connectionTimeoutMs: timeoutMs });
    await this.#server.start("Delivery control is already running");
    this.#events = new PrivateIpcServer(`${path}.events`, socket => {
      socket.on("error", () => {});
      socket.on("end", () => socket.destroy());
      const handshake = setTimeout(() => socket.destroy(), timeoutMs);
      void readFrame(socket).then(value => {
        z.strictObject({ version: z.literal(1), action: z.literal("watch") }).parse(value);
        if (this.#closed || socket.destroyed) return;
        this.#subscribers.add(socket);
        const send = type => { if (!socket.write(`${JSON.stringify({ version: 1, type })}\n`)) socket.destroy(); };
        const heartbeat = setInterval(() => send("heartbeat"), 15_000);
        socket.once("close", () => { clearInterval(heartbeat); this.#subscribers.delete(socket); });
        socket.on("data", () => socket.destroy());
        send("changed"); // Subscribe before the initial snapshot so no change can fall through the gap.
      }).catch(() => socket.destroy()).finally(() => clearTimeout(handshake));
    }, { maximumConnections: 8, connectionTimeoutMs: 300_000 });
    try { await this.#events.start("Delivery notifications are already running"); }
    catch (error) { await this.#server.close(); throw error; }
  }
  changed() {
    if (this.#closed || this.#notification) return;
    this.#notification = setTimeout(() => {
      this.#notification = undefined;
      for (const socket of this.#subscribers) {
        if (!socket.write('{"version":1,"type":"changed"}\n')) socket.destroy();
      }
    }, 100);
  }
  async close() {
    this.#closed = true;
    clearTimeout(this.#notification);
    await Promise.all([this.#events?.close(), this.#server?.close()]);
  }
}

/** Authenticated private stream; abort and peer loss release every listener and timer. */
export async function watchDeliveryChanges(directory, signal, receive) {
  signal.throwIfAborted();
  const path = `${deliveryControlSocketPath(directory)}.events`;
  validateParent(path);
  const socket = createPrivateIpcConnection(path);
  try {
    await new Promise((resolve, reject) => {
      let buffer = "";
      const abort = () => socket.destroy();
      signal.addEventListener("abort", abort, { once: true });
      socket.setTimeout(35_000, abort);
      socket.once("error", reject);
      socket.once("close", () => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) resolve(); else reject(new Error("Delivery notifications disconnected"));
      });
      socket.once("connect", () => socket.write('{"version":1,"action":"watch"}\n'));
      socket.on("data", chunk => {
        buffer += chunk.toString();
        if (buffer.length > 4096) { socket.destroy(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const event = z.strictObject({ version: z.literal(1), type: z.enum(["changed", "heartbeat"]) }).parse(JSON.parse(line));
            receive(event.type);
          } catch { socket.destroy(); return; }
        }
      });
      if (signal.aborted) abort();
    });
  } finally { socket.destroy(); }
}

/** null proves no command was sent; after writing, any connection loss is unconfirmed. */
export async function requestDeliveryResolution(directory, entries, action) {
  const request = requestSchema.parse({ version: 1, entries, action });
  let socket;
  try {
    const path = deliveryControlSocketPath(directory);
    validateParent(path);
    socket = createPrivateIpcConnection(path);
  }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  let sent = false;
  const timer = setTimeout(() => socket.destroy(), timeoutMs);
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Delivery control connection closed")));
    });
    const response = readFrame(socket);
    sent = true;
    socket.write(`${JSON.stringify(request)}\n`);
    return responseSchema.parse(await response).result;
  } catch (error) {
    if (!sent && error?.code === "ECONNREFUSED") return null;
    return "unconfirmed";
  } finally { clearTimeout(timer); socket.destroy(); }
}
