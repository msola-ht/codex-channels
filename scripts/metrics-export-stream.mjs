import { Worker } from "node:worker_threads";
import { setImmediate } from "node:timers";
import {
  MetricsExportError, metricsExportChunkBytes, metricsExportMaximumBytes,
  metricsExportMaximumConcurrent, metricsExportInitializationMs,
  metricsExportTimeoutMs, metricsExportShutdownMs,
} from "./metrics-export-limits.mjs";

// Slots remain owned until exit, including after a termination wait expires.
const active = new Set();

export function createMetricsExportOwner() {
  const jobs = new Set();
  let closed = false;
  return {
    async stream(environment, options, { format = "json", output, signal } = {}) {
      if (closed || signal?.aborted) throw new MetricsExportError("metrics_export_cancelled");
      if (active.size >= metricsExportMaximumConcurrent) throw new MetricsExportError("metrics_export_busy");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      let worker;
      try {
        worker = new Worker(new URL("./metrics-export-worker.mjs", import.meta.url), {
          execArgv: ["--disable-warning=ExperimentalWarning"],
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
          workerData: {
            environment: {
              CODEX_CONNECT_CONFIG_FILE: environment.CODEX_CONNECT_CONFIG_FILE,
              CODEX_CONNECT_HOME: environment.CODEX_CONNECT_HOME,
            }, options, format,
          },
        });
      } catch {
        signal?.removeEventListener("abort", abort);
        throw new MetricsExportError("metrics_export_unavailable");
      }
      let exited = false;
      let resolveExit;
      const exit = new Promise(resolve => { resolveExit = resolve; });
      const job = { controller, exit, close: () => { if (!exited) worker.postMessage({ type: "close" }); } };
      active.add(job);
      jobs.add(job);
      worker.once("exit", () => {
        exited = true;
        active.delete(job);
        jobs.delete(job);
        resolveExit();
      });
      let initializationTimer;
      let requestTimer;
      let shutdownTimer;
      let shutdownDeadline;
      let bytes = 0;
      let writing = false;
      let done = false;
      try {
        await new Promise((resolve, reject) => {
          let failed = false;
          const fail = error => {
            if (failed) return;
            failed = true;
            reject(error);
          };
          const cancelled = () => fail(new MetricsExportError("metrics_export_cancelled"));
          controller.signal.addEventListener("abort", cancelled, { once: true });
          initializationTimer = setTimeout(() => fail(new MetricsExportError("metrics_export_timeout")), metricsExportInitializationMs);
          const onOutputError = () => fail(new MetricsExportError("metrics_export_cancelled"));
          const releaseOutput = () => {
            if (exited && !writing) setImmediate(() => output.off("error", onOutputError));
          };
          output.on("error", onOutputError);
          worker.on("error", () => fail(new MetricsExportError("metrics_export_unavailable")));
          worker.once("exit", code => {
            releaseOutput();
            controller.signal.removeEventListener("abort", cancelled);
            if (done && code === 0) resolve();
            else fail(new MetricsExportError("metrics_export_unavailable"));
          });
          worker.on("message", message => {
            if (failed) return;
            if (message?.type === "ready") {
              clearTimeout(initializationTimer);
              requestTimer = setTimeout(() => fail(new MetricsExportError("metrics_export_timeout")), metricsExportTimeoutMs);
            } else if (message?.type === "failed") fail(new MetricsExportError(message.code));
            else if (message?.type === "done") {
              done = true;
              clearTimeout(requestTimer);
              shutdownDeadline = Date.now() + metricsExportShutdownMs;
              shutdownTimer = setTimeout(() => fail(new MetricsExportError("metrics_export_unavailable")), metricsExportShutdownMs);
            }
            else if (message?.type === "chunk") {
              const chunk = message.chunk;
              if (writing || !(chunk instanceof Uint8Array) || chunk.byteLength > metricsExportChunkBytes
                || (bytes += chunk.byteLength) > metricsExportMaximumBytes) {
                fail(new MetricsExportError("metrics_export_capacity"));
                return;
              }
              writing = true;
              try {
                // Acknowledge only after the sink has consumed this chunk.
                output.write(chunk, error => {
                  writing = false;
                  if (error) fail(new MetricsExportError("metrics_export_cancelled"));
                  else if (!failed && !exited && !controller.signal.aborted) worker.postMessage({ type: "next" });
                  releaseOutput();
                });
              } catch {
                writing = false;
                fail(new MetricsExportError("metrics_export_cancelled"));
                releaseOutput();
              }
            }
          });
          if (signal?.aborted) abort();
        });
      } finally {
        clearTimeout(initializationTimer);
        clearTimeout(requestTimer);
        clearTimeout(shutdownTimer);
        signal?.removeEventListener("abort", abort);
        if (!exited) {
          job.close();
          // Unix has no ACL helper child. Windows must retain the whole owner
          // until its nested helper confirms the PowerShell process has closed.
          const remainingMs = shutdownDeadline === undefined ? metricsExportShutdownMs : Math.max(0, shutdownDeadline - Date.now());
          const termination = process.platform === "win32" ? null : setTimeout(() => {
            if (!exited) void worker.terminate().catch(() => {});
          }, Math.min(100, remainingMs));
          try { await waitForExit(exit, remainingMs); }
          finally { if (termination !== null) clearTimeout(termination); }
        }
      }
    },
    async close() {
      closed = true;
      for (const job of jobs) { job.controller.abort(); job.close(); }
      await waitForExit(Promise.all([...jobs].map(job => job.exit)));
    },
    async waitForExit() {
      await Promise.all([...jobs].map(job => job.exit));
    },
  };
}

async function waitForExit(exit, timeoutMs = metricsExportShutdownMs) {
  let timer;
  try {
    await Promise.race([exit, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new MetricsExportError("metrics_export_unavailable")), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
