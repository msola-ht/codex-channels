import { Worker } from "node:worker_threads";
import { z } from "zod";

export const metricsReadInitializationMs = 10_000;
export const metricsReadTimeoutMs = 30_000;
export const metricsReadShutdownMs = 3_000;
export const metricsReadMaximumConcurrent = 2;

const messages = {
  metrics_read_busy: "指标读取任务已达并发上限，请稍后重试",
  metrics_read_timeout: "指标读取超时，请缩小时间范围或增加筛选后重试",
  metrics_read_cancelled: "指标读取已取消",
  metrics_read_unavailable: "指标读取失败，请检查数据库状态后重试",
  metrics_database_unavailable: "指标数据库尚未创建，请先运行 Gateway 收集模型请求",
  metrics_database_incompatible: "指标数据库版本或结构不兼容，仅支持当前 Schema；请核对版本及备份，勿删除数据库",
};

export class MetricsReadError extends Error {
  constructor(code, phase = "read", reasonCode) {
    const supported = Object.hasOwn(messages, code) ? code : "metrics_read_unavailable";
    super(messages[supported]);
    this.code = supported;
    this.phase = ["initialization", "read", "shutdown"].includes(phase) ? phase : "read";
    if (Object.hasOwn(messages, reasonCode)) this.reasonCode = reasonCode;
  }
}

const id = z.string().min(1).max(128).refine(value => value.trim().length > 0);
const threadId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const range = z.strictObject({ name: z.string().min(1).max(128), startAtMs: timestamp, endAtMs: timestamp })
  .refine(value => value.startAtMs <= value.endAtMs);
const filters = {
  threadId: id.optional(), turnId: id.optional(), provider: z.union([id, z.array(id).min(1)]).optional(),
  model: id.optional(), filter: id.optional(), callerId: id.optional(),
  source: z.enum(["owned", "relay"]).optional(), operation: z.enum(["response", "compact", "imageGeneration", "imageEdit"]).optional(),
  requestPurpose: z.enum(["unmarked", "autoApprovalReview"]).optional(),
  status: z.enum(["completed", "failed", "incomplete", "unknown"]).optional(),
};
const pagination = {
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  limit: z.number().int().min(1).max(500), sortDirection: z.enum(["asc", "desc"]),
};
const requestQuery = z.strictObject({ ...filters, ...pagination,
  sortKey: z.enum(["recordedAtMs", "provider", "model", "operation", "status", "httpStatus", "error", "inputTokens", "outputTokens", "reasoningOutputTokens", "totalDurationMs", "requestBytes"]),
});
const threadQuery = z.strictObject({ ...filters, ...pagination,
  sortKey: z.enum(["time", "last", "thread", "provider", "model", "turns", "requests", "input", "output", "totalTokens", "compact"]),
});
const turnQuery = z.strictObject({ ...filters, ...pagination,
  sortKey: z.enum(["time", "last", "turn", "provider", "model", "requests", "failures", "input", "output", "compact"]),
});
const subagentQuery = z.strictObject({ ...pagination, limit: z.number().int().min(1).max(100),
  sortKey: z.enum(["time", "last"]), parentTurnId: id.optional(),
});
const taskSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("providers"), nowMs: timestamp }),
  z.strictObject({ operation: z.literal("overview"), nowMs: timestamp, range, heatmapRange: range, modelAliases: z.record(z.string(), z.string()) }),
  z.strictObject({ operation: z.literal("daily"), nowMs: timestamp, range }),
  z.strictObject({ operation: z.literal("threads"), nowMs: timestamp, range, query: threadQuery }),
  z.strictObject({ operation: z.literal("turns"), nowMs: timestamp, range, threadId, query: turnQuery }),
  z.strictObject({ operation: z.literal("run"), nowMs: timestamp, threadId }),
  z.strictObject({ operation: z.literal("subagents"), nowMs: timestamp, threadId: threadId.optional(), query: subagentQuery }),
  z.strictObject({ operation: z.literal("requests"), nowMs: timestamp, range, query: requestQuery }),
  z.strictObject({ operation: z.literal("errors"), nowMs: timestamp, range, query: requestQuery }),
  z.strictObject({ operation: z.literal("accounts"), nowMs: timestamp, provider: id.optional() }),
  z.strictObject({ operation: z.literal("latestUserAgent"), nowMs: timestamp }),
  z.strictObject({ operation: z.literal("relayUsage"), nowMs: timestamp, startAtMs: timestamp,
    callers: z.array(z.strictObject({ callerId: id, keyId: id })),
  }),
]);

/** Internal structured-clone boundary: no arbitrary Store method or SQL dispatch. */
export function parseMetricsReadTask(task) {
  const parsed = taskSchema.safeParse(task);
  if (!parsed.success) throw new MetricsReadError("metrics_read_unavailable");
  if (parsed.data.operation === "subagents" && parsed.data.threadId === undefined && parsed.data.query.parentTurnId !== undefined) {
    throw new MetricsReadError("metrics_read_unavailable");
  }
  return parsed.data;
}

// Shared across owners: even an unconfirmed termination continues to occupy a slot.
const active = new Set();

export function createMetricsReadOwner() {
  const jobs = new Set();
  let closed = false;
  return {
    async read(environment, input, { signal } = {}) {
      if (closed || signal?.aborted) throw new MetricsReadError("metrics_read_cancelled");
      const task = parseMetricsReadTask(input);
      if (active.size >= metricsReadMaximumConcurrent) throw new MetricsReadError("metrics_read_busy");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let worker;
      try {
        worker = new Worker(new URL("./webui-metrics-worker.mjs", import.meta.url), {
          execArgv: ["--disable-warning=ExperimentalWarning"],
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          workerData: { task, environment: {
            CODEX_CONNECT_CONFIG_FILE: environment.CODEX_CONNECT_CONFIG_FILE,
            CODEX_CONNECT_HOME: environment.CODEX_CONNECT_HOME,
          } },
        });
      } catch {
        signal?.removeEventListener("abort", abort);
        throw new MetricsReadError("metrics_read_unavailable");
      }
      let exited = false;
      let ready = false;
      let resolveExit;
      const exit = new Promise(resolve => { resolveExit = resolve; });
      const stop = () => {
        if (exited) return;
        // Before readiness Windows can still own an ACL helper; retain ownership
        // and allow its existing bounded cleanup instead of orphaning the child.
        // terminate() can wait for a synchronous native SQLite call to return.
        // Neither its request nor the shutdown deadline releases this job's slot.
        if (ready || process.platform !== "win32") void worker.terminate().catch(() => {});
        else worker.postMessage({ type: "close" });
      };
      const job = { exit, stop: () => { controller.abort(); stop(); } };
      active.add(job);
      jobs.add(job);
      worker.once("exit", () => {
        exited = true;
        active.delete(job);
        jobs.delete(job);
        resolveExit();
      });
      let timer;
      let result;
      let done = false;
      let failure;
      try {
        return await new Promise((resolve, reject) => {
          let failed = false;
          const fail = error => { if (!failed) { failed = true; reject(error); } };
          const cancelled = () => fail(new MetricsReadError("metrics_read_cancelled"));
          controller.signal.addEventListener("abort", cancelled, { once: true });
          timer = setTimeout(() => fail(new MetricsReadError("metrics_read_timeout", "initialization")), metricsReadInitializationMs);
          worker.on("error", () => fail(new MetricsReadError("metrics_read_unavailable", ready ? "read" : "initialization")));
          worker.once("exit", code => {
            controller.signal.removeEventListener("abort", cancelled);
            if (done && code === 0 && !failed) resolve(result);
            else fail(new MetricsReadError("metrics_read_unavailable"));
          });
          worker.on("message", message => {
            if (message?.type === "ready" && !ready && !done) {
              ready = true;
              if (failed || controller.signal.aborted) { stop(); return; }
              clearTimeout(timer);
              timer = setTimeout(() => fail(new MetricsReadError("metrics_read_timeout")), metricsReadTimeoutMs);
              worker.postMessage({ type: "read" });
            } else if (failed) return;
            else if (message?.type === "failed") fail(new MetricsReadError(message.code, ready ? "read" : "initialization"));
            else if (message?.type === "result" && ready && !done) {
              result = message.value;
              done = true;
              clearTimeout(timer);
              timer = setTimeout(() => fail(new MetricsReadError("metrics_read_unavailable", "shutdown")), metricsReadShutdownMs);
            } else fail(new MetricsReadError("metrics_read_unavailable"));
          });
          if (signal?.aborted) abort();
        });
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!exited) {
          stop();
          await waitForExit(exit, failure?.code);
        }
      }
    },
    async close() {
      closed = true;
      for (const job of jobs) job.stop();
      await waitForExit(Promise.all([...jobs].map(job => job.exit)));
    },
    async waitForExit() { await Promise.all([...jobs].map(job => job.exit)); },
  };
}

async function waitForExit(exit, reasonCode) {
  let timer;
  try {
    await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new MetricsReadError("metrics_read_unavailable", "shutdown", reasonCode)), metricsReadShutdownMs);
    })]);
  } finally { clearTimeout(timer); }
}
