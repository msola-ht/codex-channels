import { parentPort, workerData } from "node:worker_threads";
import { SqliteScheduledTaskStore, ScheduledTaskSchemaError } from "./sqlite-store.js";
import { ScheduledTaskStateError } from "./types.js";
import {
  scheduledTaskWorkerMethods,
  type ScheduledTaskWorkerReply,
  type ScheduledTaskWorkerRequest,
} from "./sqlite-worker-protocol.js";

const port = parentPort!;
function failure(id: number, error: unknown): ScheduledTaskWorkerReply {
  if (error instanceof ScheduledTaskStateError) {
    return { id, ok: false, reason: "state", stateMessage: error.message };
  }
  const reason = error instanceof ScheduledTaskSchemaError ? "schema"
    : error instanceof RangeError ? "invalid-input"
    : error instanceof Error && "code" in error && error.code === "ERR_SQLITE_ERROR" ? "sqlite" : "storage";
  return { id, ok: false, reason };
}

try {
  const store = new SqliteScheduledTaskStore((workerData as { path: string }).path);
  port.on("message", (request: ScheduledTaskWorkerRequest) => {
    try {
      if (!scheduledTaskWorkerMethods.includes(request.method)) throw new Error("Unsupported storage operation");
      const operation = Reflect.get(store, request.method) as (...args: unknown[]) => unknown;
      const value: unknown = Reflect.apply(operation, store, request.args);
      port.postMessage({ id: request.id, ok: true, value } satisfies ScheduledTaskWorkerReply);
    } catch (error) {
      port.postMessage(failure(request.id, error));
    }
  });
  port.postMessage({ id: 0, ok: true, value: null } satisfies ScheduledTaskWorkerReply);
} catch (error) {
  port.postMessage(failure(0, error));
  port.close();
}
