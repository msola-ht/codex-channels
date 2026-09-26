import { parentPort, workerData } from "node:worker_threads";
import type { CompletionMetricsRequest, CompletionMetricsResponse } from "./completion-metrics-reader.js";
import { SqliteModelRequestMetricsStore } from "./sqlite-request-metrics-store.js";

const { path } = workerData as { path: string };
const store = new SqliteModelRequestMetricsStore(path, undefined, { readOnly: true });
parentPort!.on("message", (request: CompletionMetricsRequest) => {
  let response: CompletionMetricsResponse;
  try {
    const value = request.method === "threadSummary"
      ? store.threadSummary(request.threadId)
      : store[request.method](request.threadId, request.turnId);
    response = { id: request.id, ok: true, value };
  } catch {
    response = { id: request.id, ok: false };
  }
  parentPort!.postMessage(response);
});
parentPort!.on("close", () => store.close());
