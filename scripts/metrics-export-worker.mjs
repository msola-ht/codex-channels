import { parentPort, workerData } from "node:worker_threads";
import { openMetricsExport } from "./metrics-database-access.mjs";
import { renderMetricsExport } from "./metrics-output-renderer.mjs";
import { closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "../runtime/windows-acl-bridge.mjs";
import {
  MetricsExportError, metricsExportChunkBytes, metricsExportMaximumBytes,
} from "./metrics-export-limits.mjs";

const port = parentPort;
if (!port) throw new Error("指标导出 Worker 缺少父端口");
let acknowledgement;
let stopping = false;
let finishing = false;
let cleanupTask;
let reader;
function cleanup() {
  if (cleanupTask) return cleanupTask;
  cleanupTask = closeWindowsAclBridge({ timeoutMs: 2_000 }).then(() => {
    port.close();
  }, async () => {
    port.postMessage({ type: "failed", code: "metrics_export_unavailable" });
    await waitForWindowsAclBridgeExit();
    port.close();
  }).finally(() => { cleanupTask = undefined; });
  return cleanupTask;
}
port.on("message", message => {
  if (message?.type === "close") {
    stopping = true;
    acknowledgement?.();
    acknowledgement = undefined;
    if (finishing) void cleanup();
  }
  if (message?.type === "next") { acknowledgement?.(); acknowledgement = undefined; }
});

try {
  reader = openMetricsExport(workerData.environment, workerData.options);
  port.postMessage({ type: "ready" });
  let bytes = 0;
  let parts = [];
  let size = 0;
  const send = async () => {
    if (stopping) throw new MetricsExportError("metrics_export_cancelled");
    const chunk = Buffer.concat(parts, size);
    const next = new Promise(resolve => { acknowledgement = resolve; });
    port.postMessage({ type: "chunk", chunk });
    parts = [];
    size = 0;
    await next;
    if (stopping) throw new MetricsExportError("metrics_export_cancelled");
  };
  for (const text of renderMetricsExport(reader.frames, workerData.format)) {
    const value = Buffer.from(text);
    bytes += value.length;
    if (bytes > metricsExportMaximumBytes) throw new MetricsExportError("metrics_export_capacity");
    for (let offset = 0; offset < value.length;) {
      const length = Math.min(metricsExportChunkBytes - size, value.length - offset);
      parts.push(value.subarray(offset, offset + length));
      offset += length;
      size += length;
      if (size === metricsExportChunkBytes) await send();
    }
  }
  if (size > 0) await send();
  port.postMessage({ type: "done" });
} catch (error) {
  // 只跨线程发送已定义错误分类，绝不转发 SQLite/配置异常正文。
  port.postMessage({ type: "failed", code: new MetricsExportError(error?.code).code });
} finally {
  try { reader?.close(); }
  catch { port.postMessage({ type: "failed", code: "metrics_export_unavailable" }); }
  finishing = true;
  await cleanup();
}
