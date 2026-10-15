import { parentPort, workerData } from "node:worker_threads";
import { serialize } from "node:v8";
import { SqliteModelRequestMetricsStore } from "./sqlite-request-metrics-store.js";
import { gatewayMetricsMethods, type MetricsWorkerFailure, type MetricsWorkerRequest, type MetricsWorkerResponse } from "./metrics-worker-protocol.js";

const port = parentPort;
if (!port) throw new Error("指标 Worker 缺少父端口");
const send = (message: MetricsWorkerResponse): void => port.postMessage(message);
let store: SqliteModelRequestMetricsStore | undefined;
try {
  const options = workerData as { path: string; retentionDays: number; maximumRows: number };
  store = new SqliteModelRequestMetricsStore(options.path, undefined, options);
  send({ type: "ready" });
} catch (error) {
  send({ type: "failed", reason: classify(error) });
  port.close();
}

port.on("message", (request: MetricsWorkerRequest) => {
  if (request.type === "close") {
    let ok = true;
    try { store?.close(); } catch { ok = false; }
    send({ type: "closed", ok });
    port.close();
    return;
  }
  try {
    if (!store || !gatewayMetricsMethods.includes(request.method)) throw new Error("不支持的指标操作");
    if (Date.now() >= request.deadline) {
      send({ type: "result", id: request.id, ok: false, reason: "expired" });
      return;
    }
    // The method allowlist and correlated argument union never expose arbitrary SQL.
    const invoke = (store[request.method] as (...args: readonly unknown[]) => unknown).bind(store);
    const value = invoke(...request.args);
    if (serialize(value).byteLength > 8 * 1024 * 1024) {
      send({ type: "result", id: request.id, ok: false, reason: "capacity" });
    } else send({ type: "result", id: request.id, ok: true, value });
  } catch (error) {
    send({ type: "result", id: request.id, ok: false, reason: classify(error) });
  }
});

function classify(error: unknown): MetricsWorkerFailure {
  if (error instanceof Error && "code" in error && error.code === "METRICS_DATABASE_LOCKED") return "locked";
  if (error instanceof Error && error.name === "ModelRequestMetricsSchemaError") return "schema";
  return "operation";
}
