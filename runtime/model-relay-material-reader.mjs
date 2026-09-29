import { Worker } from "node:worker_threads";

/** A single cancellable worker keeps synchronous private-file/ACL reads off the listener thread. */
export class ModelRelayMaterialReader {
  #worker;
  #pending;
  #terminating;
  #closed = false;
  constructor(configPath, environment, purpose = "provider") { this.configPath = configPath; this.environment = environment; this.purpose = purpose; }
  read() {
    if (this.#closed || this.#terminating) return Promise.reject(new Error("Relay material reader unavailable"));
    if (this.#pending) return this.#pending.promise;
    if (!this.#worker) {
      const worker = new Worker(new URL("./model-relay-material-worker.mjs", import.meta.url), {
        workerData: { configPath: this.configPath, environment: this.environment, purpose: this.purpose },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      // Keep an error handler while idle as well as during reads.
      worker.on("error", () => { if (this.#worker === worker) this.#worker = undefined; });
      worker.on("exit", () => { if (this.#worker === worker) this.#worker = undefined; });
      this.#worker = worker;
    }
    const worker = this.#worker;
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    const cleanup = () => {
      clearTimeout(timer); worker.off("message", receive); worker.off("error", failure); worker.off("exit", failure);
      this.#pending = undefined;
    };
    const failure = () => {
      cleanup(); reject(new Error("Relay materials unavailable")); this.#worker = undefined;
      this.#terminating = worker.terminate().finally(() => { this.#terminating = undefined; });
    };
    const receive = result => { cleanup(); if (this.#closed || !result.ok) reject(new Error("Relay materials invalid")); else resolve(result); };
    const timer = setTimeout(failure, this.purpose === "metrics" ? 750 : 2000);
    worker.once("message", receive); worker.once("error", failure); worker.once("exit", failure);
    this.#pending = { promise, cancel: failure }; worker.postMessage({ operation: "read" });
    return promise;
  }
  async close() {
    if (this.#closed) return;
    this.#closed = true; this.#pending?.cancel();
    const task = this.#terminating ?? this.#worker?.terminate(); this.#worker = undefined;
    if (!task) return;
    let timer;
    try { await Promise.race([task, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]); }
    finally { clearTimeout(timer); }
  }
}
