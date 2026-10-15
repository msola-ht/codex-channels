import { parentPort, workerData } from "node:worker_threads";
import { closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "../../runtime/windows-acl-bridge.mjs";
import { SqliteDeliveryJournal } from "./sqlite-journal.js";
import { DeliveryError, type DeliveryFailure, type DeliveryLimits, type WorkerReply, type WorkerRequest } from "./types.js";

function failureReason(error: unknown): DeliveryFailure["reason"] {
  if (error instanceof DeliveryError && error.code === "conflict") return "conflict";
  if (error instanceof Error && error.name === "WindowsPrivatePathError") return "acl";
  if (error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR") return "sqlite";
  if (error instanceof DeliveryError && error.cause !== undefined) return failureReason(error.cause);
  return "storage";
}

const port = parentPort!;
const options = workerData as { directory: string; limits?: DeliveryLimits; mode?: "runtime" | "maintenance"; cancellation: Int32Array };
let store: SqliteDeliveryJournal | undefined;
let closing: Promise<void> | undefined;
function close(id: number): Promise<void> {
  if (closing) return closing;
  closing = (async () => {
    let storeFailed = false;
    try { store?.close(); } catch { storeFailed = true; }
    try { await closeWindowsAclBridge({ timeoutMs: 1_000 }); }
    catch {
      port.postMessage({ id, ok: false, code: "storage", failure: { phase: "worker", reason: "timeout", operation: "close" } } satisfies WorkerReply);
      // Keep ownership of the nested helper until its real exit is confirmed.
      await waitForWindowsAclBridgeExit();
    }
    port.postMessage(storeFailed
      ? { id, ok: false, code: "storage", failure: { phase: "worker", reason: "storage", operation: "close" } } satisfies WorkerReply
      : { id, ok: true, result: null } satisfies WorkerReply);
    port.close();
  })();
  return closing;
}
// Install cleanup before initialization can block in a private-path helper.
port.on("message", ({ id, command }: WorkerRequest) => {
  if (closing) return;
  if (command.type === "close" || Atomics.load(options.cancellation, 0) !== 0) {
    void close(command.type === "close" ? id : -1);
    return;
  }
  try {
    const result = store!.execute(command);
    port.postMessage({ id, ok: true, result } satisfies WorkerReply);
  } catch (error) {
    port.postMessage({ id, ok: false, code: error instanceof DeliveryError ? error.code : "storage", failure: { phase: "request", reason: failureReason(error), operation: command.type } } satisfies WorkerReply);
    if (!(error instanceof DeliveryError) || error.code === "storage") void close(-1);
  }
});
try {
  store = new SqliteDeliveryJournal(options.directory, options.limits, options.mode);
  if (Atomics.load(options.cancellation, 0) !== 0) void close(-1);
  else port.postMessage({ id: 0, ok: true, result: null } satisfies WorkerReply);
} catch (error) {
  port.postMessage({ id: 0, ok: false, code: error instanceof DeliveryError ? error.code : "storage", failure: { phase: "startup", reason: failureReason(error) } } satisfies WorkerReply);
  void close(-1);
}
