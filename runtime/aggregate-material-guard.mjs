import { createHash } from "node:crypto";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { readPrivateFileSync } from "./private-file.mjs";

// Only immutable paths and hashes cross this boundary; never account credentials.
if (!isMainThread && workerData?.kind === "aggregate-material-guard") {
  parentPort.on("message", ({ id }) => {
    let ok = false;
    try {
      ok = workerData.files.every(file => createHash("sha256")
        .update(readPrivateFileSync(file.path, file.maximumBytes)).digest("hex") === file.digest);
    } catch { /* Changed, missing or no longer private material fails closed. */ }
    parentPort.postMessage({ id, ok });
  });
}

/** A bounded worker keeps private-file/Windows ACL verification off the service loop. */
export class AggregateMaterialGuard {
  #worker;
  #pending = new Map();
  #sequence = 0;
  #closed = false;
  #closing;

  constructor(files) {
    this.#worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: "aggregate-material-guard", files },
      execArgv: process.execArgv.filter(arg => !arg.startsWith("--input-type")),
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    });
    this.#worker.on("message", result => {
      const entry = this.#pending.get(result.id);
      if (!entry) return;
      this.#pending.delete(result.id);
      entry.cleanup();
      if (result.ok === true && !this.#closed) entry.resolve();
      else entry.reject(new Error("聚合账户或目录已变化，请重启 App Server 服务"));
    });
    this.#worker.on("error", () => { void this.close().catch(() => undefined); });
    this.#worker.on("exit", () => { void this.close().catch(() => undefined); });
  }

  check(signal) {
    if (this.#closed || this.#pending.size >= 16) return Promise.reject(new Error("聚合材料复核不可用"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      // Cancel the waiter, but retain the queue slot until the worker finishes.
      // Repeated cancelled uploads cannot build an unbounded worker queue.
      const cancel = () => reject(signal.reason);
      const timer = setTimeout(() => { void this.close().catch(() => undefined); }, 15_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.#pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.#worker.postMessage({ id }); }
      catch { void this.close().catch(() => undefined); }
    });
  }

  close() {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const entry of this.#pending.values()) {
      entry.cleanup();
      entry.reject(new Error("聚合材料复核已关闭"));
    }
    this.#pending.clear();
    const termination = this.#worker.terminate();
    let timer;
    this.#closing = Promise.race([
      termination,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("聚合材料复核线程关闭超时")), 5_000); }),
    ]).then(() => undefined).finally(() => clearTimeout(timer));
    return this.#closing;
  }
}
