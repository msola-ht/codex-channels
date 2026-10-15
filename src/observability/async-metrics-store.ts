import { Worker } from "node:worker_threads";
import { serialize } from "node:v8";
import {
  gatewayMetricsMethods, type AsyncGatewayMetricsStore, type MetricsArguments,
  type MetricsMethod, type MetricsResult, type MetricsWorkerRequest, type MetricsWorkerResponse,
} from "./metrics-worker-protocol.js";

const initializationTimeoutMs = 15_000;
const requestTimeoutMs = 2_000;
const shutdownTimeoutMs = 5_000;
const maximumQueueCount = 256;
const maximumQueueBytes = 8 * 1024 * 1024;

interface Pending {
  message: Extract<MetricsWorkerRequest, { type: "request" }>;
  bytes: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal: AbortSignal | undefined;
  abort: () => void;
  cancelled?: boolean;
}

/** Sole Gateway database owner, including reads, retention and confirmed close. */
export class AsyncMetricsStore {
  readonly ready: Promise<void>;
  readonly store: AsyncGatewayMetricsStore;
  private readonly worker: Worker;
  private readonly exit: Promise<void>;
  private readonly queue: Pending[] = [];
  private active: Pending | undefined;
  private bytes = 0;
  private sequence = 0;
  private initialized = false;
  private exited = false;
  private closing = false;
  private failure: Error | undefined;
  private closeTask: Promise<void> | undefined;
  private closeAcknowledged = false;
  private readonly idleWaiters = new Set<() => void>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly initializationTimer: NodeJS.Timeout;

  constructor(path: string, options: { retentionDays: number; maximumRows: number }, private readonly onFatal?: (error: Error) => void) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // Construction owns cleanup even when a later constructor operation fails.
    void this.ready.catch(() => undefined);
    this.worker = new Worker(new URL("./metrics-worker.js", import.meta.url), {
      workerData: { path, ...options }, execArgv: [],
    });
    this.store = this.withSignal();
    this.initializationTimer = setTimeout(() => this.fail(this.error("initialization", "timeout")), initializationTimeoutMs);
    this.worker.on("message", (message: MetricsWorkerResponse) => this.receive(message));
    this.worker.on("error", () => this.fail(this.error(this.initialized ? "request" : "initialization", "worker-unavailable")));
    this.exit = new Promise(resolve => this.worker.once("exit", () => {
      this.exited = true;
      this.fail(this.error(this.closing ? "close" : "request", "worker-exited"));
      resolve();
    }));
  }

  withSignal(signal?: AbortSignal): AsyncGatewayMetricsStore {
    return Object.fromEntries(gatewayMetricsMethods.map(method => [method,
      (...args: MetricsArguments<typeof method>) => this.request(method, args, signal),
    ])) as AsyncGatewayMetricsStore;
  }

  private request<K extends MetricsMethod>(method: K, args: MetricsArguments<K>, signal?: AbortSignal): Promise<MetricsResult<K>> {
    if (this.closing || this.failure || signal?.aborted) return Promise.reject(this.failure ?? this.error("request", signal?.aborted ? "cancelled" : "closing", method));
    let bytes: number;
    let cloned: MetricsArguments<K>;
    try { bytes = serialize(args).byteLength; }
    catch { return Promise.reject(this.error("request", "invalid-input", method)); }
    if (this.queue.length + Number(Boolean(this.active)) >= maximumQueueCount || this.bytes + bytes > maximumQueueBytes) {
      return Promise.reject(this.error("request", "capacity", method));
    }
    try { cloned = structuredClone(args); }
    catch { return Promise.reject(this.error("request", "invalid-input", method)); }
    return new Promise<MetricsResult<K>>((resolve, reject) => {
      const message = { type: "request", id: ++this.sequence, method, args: cloned, deadline: Date.now() + requestTimeoutMs } as Extract<MetricsWorkerRequest, { type: "request" }>;
      const entry: Pending = {
        message, bytes, resolve: value => resolve(value as MetricsResult<K>), reject, signal,
        timer: setTimeout(() => this.cancel(entry, "timeout"), requestTimeoutMs),
        abort: () => this.cancel(entry, "cancelled"),
      };
      this.bytes += bytes;
      this.queue.push(entry);
      signal?.addEventListener("abort", entry.abort, { once: true });
      if (signal?.aborted) entry.abort();
      else this.dispatch();
    });
  }

  private cancel(entry: Pending, reason: string): void {
    if (this.active === entry) {
      if (!new Set<MetricsMethod>(["recordBatch", "recordSubagentThread", "recordSubagentTurn", "upsertAccountSnapshot", "recordTurnExecution", "replaceThreadExecutions", "invalidateThreadExecutions", "observeAutoApprovalTurn", "recordAutoApprovalReview", "invalidateAutoApprovalCoverage", "observeTurnExecution", "invalidateAllThreadExecutions"]).has(entry.message.method)) {
        entry.cancelled = true;
        clearTimeout(entry.timer);
        entry.signal?.removeEventListener("abort", entry.abort);
        entry.reject(this.error("request", reason, entry.message.method));
        return;
      }
      // SQL may already have committed. Never retry an unknown write or reuse this connection.
      this.fail(this.error("request", `${reason}-outcome-unknown`, entry.message.method));
      return;
    }
    const index = this.queue.indexOf(entry);
    if (index < 0) return;
    this.queue.splice(index, 1);
    this.release(entry);
    entry.reject(this.error("request", reason, entry.message.method));
  }

  private receive(message: MetricsWorkerResponse): void {
    if (message.type === "ready") {
      clearTimeout(this.initializationTimer);
      if (this.failure) return;
      this.initialized = true;
      this.resolveReady();
      this.dispatch();
    } else if (message.type === "failed") this.fail(this.error("initialization", message.reason));
    else if (message.type === "closed") this.closeAcknowledged = message.ok;
    else if (message.type === "result") {
      const entry = this.active;
      if (!entry || entry.message.id !== message.id) return;
      this.active = undefined;
      this.release(entry);
      if (!this.failure && !entry.cancelled) {
        if (message.ok) entry.resolve(message.value);
        else entry.reject(this.error("request", message.reason, entry.message.method));
      }
      this.dispatch();
    }
  }

  private dispatch(): void {
    if (!this.initialized || this.active || this.failure || this.closing) return;
    const entry = this.queue.shift();
    if (!entry) return;
    if (entry.signal?.aborted || Date.now() >= entry.message.deadline) {
      this.release(entry);
      entry.reject(this.error("request", "expired", entry.message.method));
      this.dispatch();
      return;
    }
    this.active = entry;
    try { this.worker.postMessage(entry.message); }
    catch { this.fail(this.error("request", "dispatch-outcome-unknown", entry.message.method)); }
  }

  private release(entry: Pending): void {
    clearTimeout(entry.timer);
    entry.signal?.removeEventListener("abort", entry.abort);
    this.bytes -= entry.bytes;
    if (this.bytes === 0) for (const resolve of this.idleWaiters) resolve();
  }

  async drain(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.bytes === 0) return;
    let timer: NodeJS.Timeout | undefined;
    let resolveIdle!: () => void;
    try {
      await Promise.race([
        new Promise<void>(resolve => { resolveIdle = resolve; this.idleWaiters.add(resolve); }),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(this.error("close", "drain-timeout")), shutdownTimeoutMs); }),
      ]);
      if (this.failure) throw this.error("close", "worker-unavailable");
    } finally {
      this.idleWaiters.delete(resolveIdle);
      if (timer) clearTimeout(timer);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.initializationTimer);
    this.rejectReady(error);
    for (const entry of this.queue.splice(0)) { this.release(entry); entry.reject(error); }
    if (this.active) { this.release(this.active); this.active.reject(error); this.active = undefined; }
    if (!this.closing) { try { this.onFatal?.(error); } catch { /* Ownership survives failure reporting. */ } }
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.fail(this.error("close", "closing"));
    this.closeTask = (async () => {
      if (!this.exited) this.worker.postMessage({ type: "close" } satisfies MetricsWorkerRequest);
      let timer: NodeJS.Timeout | undefined;
      const confirmed = await Promise.race([
        this.exit.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), shutdownTimeoutMs); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (!confirmed) {
        // Retain this Worker/lock owner and let a subsequent close confirm its exit.
        throw this.error("close", "exit-unconfirmed");
      }
      if (!this.closeAcknowledged && this.initialized) throw this.error("close", "close-unconfirmed");
    })().finally(() => { this.closeTask = undefined; });
    return this.closeTask;
  }

  private error(phase: string, reason: string, operation?: MetricsMethod): Error {
    return new MetricsWorkerFailure(phase, reason, operation);
  }
}

class MetricsWorkerFailure extends Error {
  readonly code = "METRICS_WORKER_FAILURE";
  constructor(readonly phase: string, readonly reason: string, readonly operation?: MetricsMethod) {
    super(`指标数据库 Worker ${phase}: ${reason}${operation ? ` (${operation})` : ""}`);
    this.name = "MetricsWorkerFailure";
  }
}

/** Only errors constructed here may cross the logging boundary as classifications. */
export function metricsWorkerFailureMetadata(error: unknown): { metricsFailure?: { phase: string; reason: string; operation?: MetricsMethod } } {
  return error instanceof MetricsWorkerFailure ? { metricsFailure: {
    phase: error.phase, reason: error.reason, ...(error.operation ? { operation: error.operation } : {}),
  } } : {};
}
