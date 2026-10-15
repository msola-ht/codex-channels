import { parentPort, workerData } from "node:worker_threads";
import { serialize } from "node:v8";
import { closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "../../runtime/windows-acl-bridge.mjs";
import { SqliteModelRequestMetricsStore } from "./sqlite-request-metrics-store.js";
import { gatewayMetricsMethods, type MetricsWorkerFailure, type MetricsWorkerRequest, type MetricsWorkerResponse } from "./metrics-worker-protocol.js";

const port = parentPort;
if (!port) throw new Error("指标 Worker 缺少父端口");
const send = (message: MetricsWorkerResponse): void => port.postMessage(message);
const closePort = (): void => port.close();
const options = workerData as { path: string; retentionDays: number; maximumRows: number; cancellation: Int32Array };
let store: SqliteModelRequestMetricsStore | undefined;
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
      // A bounded cleanup failure does not release the nested process owner.
      await waitForWindowsAclBridgeExit();
    }
    send({ type: "closed", ok });
    closePort();
  })();
  return closeTask;
}

port.on("message", (request: MetricsWorkerRequest) => {
  if (request.type === "close" || Atomics.load(options.cancellation, 0) !== 0) {
    void close();
    return;
  }
  if (stopping) return;
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

try {
  if (Atomics.load(options.cancellation, 0) === 0) store = new SqliteModelRequestMetricsStore(options.path, undefined, options);
  if (Atomics.load(options.cancellation, 0) !== 0) void close();
  else send({ type: "ready" });
} catch (error) {
  send({ type: "failed", reason: classify(error) });
  void close();
}

function classify(error: unknown): MetricsWorkerFailure {
  if (error instanceof Error && "code" in error && error.code === "METRICS_DATABASE_LOCKED") return "locked";
  if (error instanceof Error && error.name === "ModelRequestMetricsSchemaError") return "schema";
  return "operation";
}
