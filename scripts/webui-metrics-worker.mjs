import { parentPort, workerData } from "node:worker_threads";
import { RequestMetricsQueryService } from "../dist/observability/index.js";
import { openReadOnlyMetricsDatabase, readWeeklyQuota } from "./metrics-database-access.mjs";
import { closeWindowsAclBridge, waitForWindowsAclBridgeExit } from "../runtime/windows-acl-bridge.mjs";
import { MetricsReadError, parseMetricsReadTask } from "./webui-metrics-read.mjs";

if (!parentPort) throw new Error("指标读取 Worker 缺少父端口");
const port = parentPort;
let store;
let stopped = false;
let read;
const command = new Promise(resolve => { read = resolve; });
port.on("message", message => {
  if (message?.type === "close") { stopped = true; read(); }
  else if (message?.type === "read") read();
});

try {
  const task = parseMetricsReadTask(workerData.task);
  store = openReadOnlyMetricsDatabase(workerData.environment, task.nowMs);
  // After this handshake all remaining work owns only SQLite; termination
  // cannot orphan an ACL helper. Native SQL may defer the actual thread exit.
  await closeWindowsAclBridge({ timeoutMs: 2_000 });
  if (!stopped) port.postMessage({ type: "ready" });
  await command;
  if (!stopped) {
    const value = store.readSnapshot(() => execute(task, store));
    store.close();
    store = undefined;
    port.postMessage({ type: "result", value });
  }
} catch (error) {
  port.postMessage({ type: "failed", code: new MetricsReadError(error?.code).code });
} finally {
  try { store?.close(); }
  catch { port.postMessage({ type: "failed", code: "metrics_read_unavailable" }); }
  try { await closeWindowsAclBridge({ timeoutMs: 2_000 }); }
  catch {
    port.postMessage({ type: "failed", code: "metrics_read_unavailable" });
    await waitForWindowsAclBridgeExit();
  }
  port.close();
}

function execute(task, store) {
  const queries = new RequestMetricsQueryService(store);
  switch (task.operation) {
    case "providers": return { providers: store.providers() };
    case "overview": {
      const generatedAt = new Date(task.nowMs).toISOString();
      const quota = readWeeklyQuota(store, task.nowMs);
      return { range: task.range, generatedAt,
        ...queries.overview(task.range, task.modelAliases),
        weeklyQuota: quota === null ? null : { ...quota, resetsAt: quota.resetsAt === null ? null : quota.resetsAt * 1000 },
        trend: { range: task.range, generatedAt, ...queries.trend(task.range) },
        heatmap: { range: task.heatmapRange, generatedAt, daily: queries.daily(task.heatmapRange) },
      };
    }
    case "daily": return queries.daily(task.range);
    case "threads": return queries.threadList(task.range, { ...task.query, mainThreadsOnly: true });
    case "turns": return queries.threadTurnSummaries(task.threadId, task.range, task.query);
    case "run": return { summary: queries.threadSummary(task.threadId), subagent: queries.subagentThread(task.threadId) };
    case "subagents": return task.threadId === undefined ? queries.subagents(task.query) : queries.threadSubagents(task.threadId, task.query);
    case "requests": return queries.page(task.range, task.query);
    case "errors": {
      const { offset, limit, sortKey, sortDirection, ...filters } = task.query;
      return {
        page: queries.page(task.range, { ...filters, offset, limit, sortKey, sortDirection, onlyFailures: true }),
        errors: queries.errors(task.range, filters),
      };
    }
    case "accounts": {
      if (task.provider === undefined) return store.latestAccountSnapshots();
      const single = store.latestAccountSnapshot(task.provider);
      return single === null ? [] : [single];
    }
    case "relayUsage": return store.relayCallerUsage(task.callers, task.startAtMs, task.nowMs);
    case "latestUserAgent": {
      const page = queries.page({ name: "all", startAtMs: 0, endAtMs: task.nowMs }, {
        offset: 0, limit: 1, sortKey: "recordedAtMs", sortDirection: "desc",
      });
      const record = page.records[0];
      return record === undefined ? null : { userAgent: record.userAgent ?? null, recordedAtMs: record.recordedAtMs ?? null };
    }
    default: throw new MetricsReadError("metrics_read_unavailable");
  }
}
