import { parentPort, workerData } from "node:worker_threads";
import { closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "../../runtime/windows-acl-bridge.mjs";
import { SqliteScheduledTaskStore, ScheduledTaskSchemaError } from "./sqlite-store.js";
import { ScheduledTaskStateError } from "./types.js";
import {
  scheduledTaskWorkerMethods,
  type ScheduledTaskWorkerReply,
  type ScheduledTaskWorkerRequest,
} from "./sqlite-worker-protocol.js";

const port = parentPort;
if (!port) throw new Error("计划任务 Worker 缺少父端口");
const options = workerData as { path: string; cancellation: Int32Array };
const send = (message: ScheduledTaskWorkerReply): void => port.postMessage(message);
const closePort = (): void => port.close();
let store: SqliteScheduledTaskStore | undefined;
let stopping = false;
let closeTask: Promise<void> | undefined;
function close(): Promise<void> {
  if (closeTask) return closeTask;
  stopping = true;
  closeTask = (async () => {
    let ok = true;
    try { store?.close(); } catch { ok = false; }
    try { await closeWindowsAclBridge({ timeoutMs: 1_000 }); }
    catch {
      ok = false;
      send({ type: "closed", ok });
      await waitForWindowsAclBridgeExit();
    }
    send({ type: "closed", ok });
    closePort();
  })();
  return closeTask;
}
function failure(id: number, error: unknown): ScheduledTaskWorkerReply {
  if (error instanceof ScheduledTaskStateError) {
    return { id, ok: false, reason: "state", stateMessage: error.message };
  }
  const reason = error instanceof ScheduledTaskSchemaError ? "schema"
    : error instanceof RangeError ? "invalid-input"
    : error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" ? "sqlite" : "storage";
  return { id, ok: false, reason };
}

port.on("message", (request: ScheduledTaskWorkerRequest) => {
  if ("type" in request) { void close(); return; }
  if (Atomics.load(options.cancellation, 0) !== 0) { void close(); return; }
  if (stopping) return;
  try {
    if (!store) throw new Error("Unsupported storage operation");
    if (!scheduledTaskWorkerMethods.includes(request.method)) throw new Error("Unsupported storage operation");
    const operation = Reflect.get(store, request.method) as (...args: unknown[]) => unknown;
    const value: unknown = Reflect.apply(operation, store, request.args);
    send({ id: request.id, ok: true, value });
  } catch (error) {
    send(failure(request.id, error));
  }
});
try {
  if (Atomics.load(options.cancellation, 0) === 0) store = new SqliteScheduledTaskStore(options.path);
  if (Atomics.load(options.cancellation, 0) !== 0) void close();
  else send({ id: 0, ok: true, value: null });
} catch (error) {
  send(failure(0, error));
  void close();
}
