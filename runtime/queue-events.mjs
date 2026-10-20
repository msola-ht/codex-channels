import { z } from "zod";
import { PrivateIpcServer, createPrivateIpcConnectionAsync } from "./private-ipc.mjs";

/** Isolated notification capacity; never carries queue contents or write commands. */
export class QueueEventsServer {
  #server;
  #subscribers = new Set();
  #notification;
  #closed = false;
  constructor(path) {
    this.#server = new PrivateIpcServer(path, socket => {
      socket.on("error", () => {});
      socket.on("end", () => socket.destroy());
      const handshake = setTimeout(() => socket.destroy(), 20_000);
      void readWatch(socket).then(value => {
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
  }
  start() { return this.#server.start("Queue notifications are already running"); }
  changed() {
    if (this.#closed || this.#notification) return;
    this.#notification = setTimeout(() => {
      this.#notification = undefined;
      for (const socket of this.#subscribers) {
        if (!socket.write('{"version":1,"type":"changed"}\n')) socket.destroy();
      }
    }, 100);
  }
  close() {
    this.#closed = true;
    clearTimeout(this.#notification);
    return this.#server.close();
  }
}

export async function watchQueueChanges(path, signal, receive) {
  signal.throwIfAborted();
  const cancellation = new AbortController();
  let socket;
  const abort = () => { cancellation.abort(); socket?.destroy(); };
  // Endpoint/ACL preparation and connecting have their own bounded allowance;
  // a live subscription is governed only by the heartbeat idle timeout below.
  const preparation = setTimeout(abort, 20_000);
  signal.addEventListener("abort", abort, { once: true });
  try {
    socket = await createPrivateIpcConnectionAsync(path, { signal: cancellation.signal });
    await new Promise((resolve, reject) => {
      let buffer = "";
      socket.on("error", () => socket.destroy());
      socket.once("close", () => {
        if (signal.aborted) resolve(); else reject(new Error("Queue notifications disconnected"));
      });
      socket.once("connect", () => {
        if (cancellation.signal.aborted) { socket.destroy(); return; }
        clearTimeout(preparation);
        socket.setTimeout(35_000, () => socket.destroy());
        socket.write('{"version":1,"action":"watch"}\n');
      });
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
      if (signal.aborted || cancellation.signal.aborted) abort();
    });
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    clearTimeout(preparation);
    signal.removeEventListener("abort", abort);
    abort();
  }
}

function readWatch(socket) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => { socket.off("data", data); socket.off("close", failed); socket.off("error", failed); socket.off("end", failed); };
    const failed = () => { cleanup(); reject(new Error("Queue subscription closed")); };
    const data = chunk => {
      buffer += chunk.toString();
      if (buffer.length > 4096) { failed(); return; }
      if (!buffer.includes("\n")) return;
      cleanup();
      try { resolve(JSON.parse(buffer)); } catch { reject(new Error("Invalid queue subscription")); }
    };
    socket.on("data", data); socket.once("close", failed); socket.once("error", failed); socket.once("end", failed);
  });
}
