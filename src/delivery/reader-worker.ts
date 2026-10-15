import { parentPort, workerData } from "node:worker_threads";
import { closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "../../runtime/windows-acl-bridge.mjs";
import { openDeliveryReader } from "./queue-reader.js";
import type { DeliveryQueueEntry } from "./types.js";
import type { DeliveryReadCommand, DeliveryReadControl, DeliveryReadFailure, DeliveryReadReply } from "./reader-protocol.js";

const port = parentPort!;
const { directory, command, cancellation } = workerData as { directory: string; command: DeliveryReadCommand; cancellation: Int32Array };
let snapshot: ReturnType<typeof openDeliveryReader> | undefined;
let baseline: Array<DeliveryQueueEntry | null> = [];
let index = 0;
let started = false;
let waiting = false;
let closed = false;
let stopping = false;
let snapshotClosed = false;
let closePromise: Promise<void> | undefined;

function send(reply: DeliveryReadReply) { port.postMessage(reply); }
function close(): Promise<void> {
  if (closed) return Promise.resolve();
  if (closePromise) return closePromise;
  stopping = true;
  closePromise = (async () => {
    let snapshotFailed = false;
    try { if (!snapshotClosed) { snapshot?.close(); snapshotClosed = true; } }
    catch { snapshotFailed = true; }
    try { await closeWindowsAclBridge({ timeoutMs: 1_000 }); }
    catch {
      send({ type: "failure", failure: { phase: "shutdown", reason: "timeout", operation: command.type } });
      // Keep the outer owner alive without retrying or replacing any helper.
      await waitForWindowsAclBridgeExit();
    }
    if (snapshotFailed) throw new Error("Reader snapshot close unconfirmed");
    closed = true;
    port.close();
  })().catch((error: unknown) => { closePromise = undefined; throw error; });
  return closePromise;
}
function fail(error: unknown, phase: DeliveryReadFailure["phase"]) {
  const reason = error instanceof Error && error.name === "WindowsPrivatePathError" ? "acl"
    : error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" ? "sqlite" : "storage";
  try { send({ type: "failure", failure: { phase, reason, operation: command.type } }); }
  finally { void close().catch(() => send({ type: "failure", failure: { phase: "shutdown", reason: "timeout", operation: command.type } })); }
}
function next() {
  if (Atomics.load(cancellation, 0) !== 0) { void close().catch(() => {}); return; }
  if (command.type !== "payload" && command.type !== "payloads") return;
  if (index === command.ids.length) {
    send({ type: "result", value: null });
    return;
  }
  waiting = true;
  const entry = baseline[index];
  send({ type: "item", index, value: entry ? snapshot!.payload(command.ids[index]!, entry.revision) : null });
}

// Register cleanup ownership before the first synchronous path/ACL/SQLite operation.
port.on("message", (message: DeliveryReadControl) => {
  if (closed) return;
  try {
    if (message.type === "close") {
      void close().catch(() => send({ type: "failure", failure: { phase: "shutdown", reason: "timeout", operation: command.type } }));
      return;
    }
    if (Atomics.load(cancellation, 0) !== 0) { void close().catch(() => {}); return; }
    if (stopping) return;
    if (message.type === "start" && !started) {
      started = true;
      if (command.type === "queue") send({ type: "result", value: snapshot!.queue(command.options) });
      else if (command.type === "entries") send({ type: "result", value: snapshot!.entries(command.ids) });
      else { baseline = snapshot!.entries(command.ids); next(); }
    } else if (message.type === "ack" && waiting && message.index === index) {
      waiting = false;
      index += 1;
      next();
    } else throw new Error("Invalid reader control");
  } catch (error) { fail(error, "request"); }
});
try {
  if (Atomics.load(cancellation, 0) === 0) snapshot = openDeliveryReader(directory, command.type === "payload" || command.type === "payloads");
  if (Atomics.load(cancellation, 0) !== 0) void close().catch(() => {});
  else send({ type: "ready" });
} catch (error) { fail(error, "startup"); }
