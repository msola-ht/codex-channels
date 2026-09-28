import { parentPort, workerData } from "node:worker_threads";
import { SqliteDeliveryJournal } from "./sqlite-journal.js";
import { DeliveryError, type DeliveryLimits, type WorkerReply, type WorkerRequest } from "./types.js";

const port = parentPort!;
let store: SqliteDeliveryJournal;
try {
  const options = workerData as { directory: string; limits?: DeliveryLimits };
  store = new SqliteDeliveryJournal(options.directory, options.limits);
  port.postMessage({ id: 0, ok: true, result: null } satisfies WorkerReply);
  port.on("message", ({ id, command }: WorkerRequest) => {
    try {
      const result = store.execute(command);
      port.postMessage({ id, ok: true, result } satisfies WorkerReply);
      if (command.type === "close") port.close();
    } catch (error) {
      port.postMessage({ id, ok: false, code: error instanceof DeliveryError ? error.code : "storage" } satisfies WorkerReply);
    }
  });
} catch (error) {
  port.postMessage({ id: 0, ok: false, code: error instanceof DeliveryError ? error.code : "storage" } satisfies WorkerReply);
  port.close();
}
