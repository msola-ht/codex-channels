import { parentPort, workerData } from "node:worker_threads";
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
let store: SqliteDeliveryJournal;
try {
  const options = workerData as { directory: string; limits?: DeliveryLimits; mode?: "runtime" | "maintenance" };
  store = new SqliteDeliveryJournal(options.directory, options.limits, options.mode);
  port.postMessage({ id: 0, ok: true, result: null } satisfies WorkerReply);
  port.on("message", ({ id, command }: WorkerRequest) => {
    try {
      const result = store.execute(command);
      port.postMessage({ id, ok: true, result } satisfies WorkerReply);
      if (command.type === "close") port.close();
    } catch (error) {
      port.postMessage({ id, ok: false, code: error instanceof DeliveryError ? error.code : "storage", failure: { phase: "request", reason: failureReason(error), operation: command.type } } satisfies WorkerReply);
    }
  });
} catch (error) {
  port.postMessage({ id: 0, ok: false, code: error instanceof DeliveryError ? error.code : "storage", failure: { phase: "startup", reason: failureReason(error) } } satisfies WorkerReply);
  port.close();
}
