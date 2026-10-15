import { Worker } from "node:worker_threads";

/** A single cancellable worker keeps synchronous private-file/ACL reads off the listener thread. */
export class ModelRelayMaterialReader {
  #worker;
  #pending;
  #terminating;
  #closeTask;
  #closed = false;
  #readyWorker;
  #workerExit;
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
      worker.on("error", () => {});
      this.#workerExit = new Promise(resolve => worker.once("exit", resolve));
      worker.on("exit", () => { if (this.#worker === worker) { this.#worker = undefined; this.#terminating = undefined; } });
      this.#worker = worker;
    }
    const worker = this.#worker;
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    let settled = false;
    let timer;
    const cleanup = () => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer); worker.off("message", receive); worker.off("error", failure); worker.off("exit", failure);
      this.#pending = undefined;
      return true;
    };
    const failure = () => {
      if (!cleanup()) return;
      reject(new Error("Relay materials unavailable"));
      void this.#terminate(worker).catch(() => {});
    };
    const receive = result => {
      if (result?.ready === true) {
        this.#readyWorker = worker;
        clearTimeout(timer);
        // The first Windows read also starts its private ACL helper.
        const initializationBudget = process.platform === "win32" ? 7_000 : budget;
        timer = setTimeout(failure, initializationBudget);
        worker.postMessage({ operation: "read", deadline: Date.now() + initializationBudget });
        return;
      }
      if (!cleanup()) return;
      if (this.#closed || !result.ok) reject(new Error("Relay materials invalid")); else resolve(result);
    };
    const budget = this.purpose === "metrics" ? 750 : 2000;
    worker.on("message", receive); worker.once("error", failure); worker.once("exit", failure);
    this.#pending = { promise, cancel: failure };
    if (this.#readyWorker === worker) {
      timer = setTimeout(failure, budget);
      worker.postMessage({ operation: "read", deadline: Date.now() + budget });
    } else timer = setTimeout(failure, 5_000);
    return promise;
  }
  #terminate(worker) {
    if (this.#terminating) return this.#terminating;
    const exit = this.#workerExit;
    worker.postMessage({ operation: "close" });
    const fallback = process.platform === "win32" ? undefined : setTimeout(() => {
      if (this.#worker === worker) void worker.terminate().catch(() => {});
    }, 100);
    const task = exit.then(() => {
      if (this.#worker === worker) this.#worker = undefined;
    }).finally(() => {
      clearTimeout(fallback);
      if (this.#worker !== worker && this.#terminating === task) this.#terminating = undefined;
    });
    this.#terminating = task;
    return task;
  }
  close() {
    this.#closed = true; this.#pending?.cancel();
    if (this.#closeTask) return this.#closeTask;
    const task = this.#terminating ?? (this.#worker ? this.#terminate(this.#worker) : undefined);
    if (!task) return Promise.resolve();
    let timer;
    this.#closeTask = Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Relay material worker shutdown unconfirmed")), 2000);
    })]).finally(() => { clearTimeout(timer); this.#closeTask = undefined; });
    return this.#closeTask;
  }
}
