import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { readAggregateMaterialFileDigest } from "./aggregate-model-provider.mjs";

// Only immutable paths and hashes cross this boundary; never account credentials.
if (!isMainThread && workerData?.kind === "aggregate-material-guard") {
  parentPort.on("message", ({ id }) => {
    let ok = false;
    try {
      ok = workerData.files.every(file => readAggregateMaterialFileDigest(file) === file.digest);
    } catch { /* Changed, missing or no longer private material fails closed. */ }
    parentPort.postMessage({ id, ok });
  });
}

/** A bounded worker keeps private-file/Windows ACL verification off the service loop. */
export class AggregateMaterialGuard {
  #files;
  #worker;
  #pending = new Map();
  #sequence = 0;
  #running;
  #retiring;
  #closed = false;
  #closing;

  constructor(files) {
    this.#files = structuredClone(files);
    this.#startWorker();
  }

  #startWorker() {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: "aggregate-material-guard", files: this.#files },
      execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")),
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    this.#worker = worker;
    worker.on("message", result => {
      if (this.#worker !== worker || result.id !== this.#running) return;
      const entry = this.#pending.get(result.id);
      if (!entry) return;
      this.#pending.delete(result.id);
      this.#running = undefined;
      entry.cleanup();
      if (result.ok === true && !this.#closed) entry.resolve();
      else entry.reject(new Error("聚合账户或目录已变化，等待安全应用设置后重试"));
      this.#dispatch();
    });
    worker.on("error", () => {
      this.#retire(worker, new Error("聚合材料复核线程失败，请重试"));
    });
    worker.on("exit", () => {
      if (this.#worker === worker) this.#retire(worker, new Error("聚合材料复核线程退出，请重试"));
      // An exit confirms cleanup even if the bounded termination wait failed.
      if (this.#retiring?.worker === worker) this.#retiring = undefined;
    });
  }

  #dispatch() {
    if (this.#closed || !this.#worker || this.#running !== undefined) return;
    const id = this.#pending.keys().next().value;
    if (id === undefined) return;
    const worker = this.#worker;
    const entry = this.#pending.get(id);
    this.#running = id;
    // Queue time is governed by each caller's cancellation, not a timer that
    // mistakes earlier checks for a stalled worker. Only one check is dispatched.
    entry.timer = setTimeout(() => {
      this.#retire(worker, new Error("聚合材料复核超时，请重试"));
    }, 15_000);
    try { worker.postMessage({ id }); }
    catch { this.#retire(worker, new Error("聚合材料复核不可用，请重试")); }
  }

  #retire(worker, error) {
    if (this.#worker !== worker) return;
    this.#worker = undefined;
    this.#running = undefined;
    for (const entry of this.#pending.values()) {
      entry.cleanup();
      entry.reject(error);
    }
    this.#pending.clear();
    const retiring = { worker, wait: undefined };
    this.#retiring = retiring;
    const termination = Promise.resolve().then(() => worker.terminate()).then(() => {
      if (this.#retiring === retiring) this.#retiring = undefined;
    });
    let timer;
    retiring.wait = Promise.race([
      termination,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("聚合材料复核线程关闭超时")), 5_000); }),
    ]).finally(() => clearTimeout(timer));
    // A deadline never authorizes overlapping workers. Keep refusing checks
    // until actual exit; the next caller then creates a fresh worker on demand.
    void retiring.wait.catch(() => undefined);
    return retiring.wait;
  }

  check(signal) {
    if (this.#closed || this.#retiring || this.#pending.size >= 16) return Promise.reject(new Error("聚合材料复核不可用"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.#worker) {
      try { this.#startWorker(); }
      catch { return Promise.reject(new Error("聚合材料复核线程启动失败，请重试")); }
    }
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        reject(signal.reason);
        // Undispatched checks have no worker resources to retain. An executing
        // cancelled check keeps its slot and deadline until completion or exit.
        if (this.#running !== id) {
          this.#pending.delete(id);
          entry.cleanup();
        }
      };
      const entry = { resolve, reject, timer: undefined,
        cleanup: () => { clearTimeout(entry.timer); signal?.removeEventListener("abort", cancel); } };
      this.#pending.set(id, entry);
      signal?.addEventListener("abort", cancel, { once: true });
      this.#dispatch();
    });
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#worker
      ? this.#retire(this.#worker, new Error("聚合材料复核已关闭"))
      : this.#retiring?.wait ?? Promise.resolve();
    return this.#closing;
  }
}
