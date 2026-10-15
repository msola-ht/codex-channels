import { Worker } from "node:worker_threads";

/** One owned worker and one shared read; only fingerprints and safe status return to its owner. */
export class ProviderSettingsSnapshotReader {
  #worker;
  #pending;
  #terminating;
  #closeTask;
  #readyWorker;
  #workerExit;
  #closed = false;
  constructor(environment, aggregateMembers = []) {
    this.environment = { ...environment };
    this.aggregateMembers = [...aggregateMembers];
  }
  async readFresh() {
    await this.#pending?.promise.catch(() => undefined);
    return this.read();
  }
  read() {
    if (this.#closed || this.#terminating) return Promise.reject(new Error("Provider settings reader unavailable"));
    if (this.#pending) return this.#pending.promise;
    if (!this.#worker) {
      const worker = new Worker(new URL("./provider-settings-snapshot-worker.mjs", import.meta.url), {
        workerData: { environment: this.environment, aggregateMembers: this.aggregateMembers },
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      worker.on("error", () => {});
      this.#workerExit = new Promise(resolve => worker.once("exit", resolve));
      worker.on("exit", () => {
        if (this.#worker === worker) {
          this.#worker = undefined;
          this.#terminating = undefined;
        }
      });
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
      clearTimeout(timer);
      worker.off("message", receive); worker.off("error", failure); worker.off("exit", failure);
      this.#pending = undefined;
      return true;
    };
    const failure = () => {
      if (!cleanup()) return;
      reject(Object.assign(new Error("Provider settings snapshot unavailable"), {
        phase: this.#readyWorker === worker ? "read" : "initialization", reason: "worker-unavailable",
      }));
      void this.#terminate(worker).catch(() => {});
    };
    const receive = result => {
      if (result?.ready === true) {
        this.#readyWorker = worker;
        clearTimeout(timer);
        // The first Windows snapshot also initializes the owned ACL bridge (up to 5 s).
        // This allowance never applies to later ordinary reads or shutdown.
        const budget = process.platform === "win32" ? 7_000 : 2_000;
        const deadline = Date.now() + budget;
        timer = setTimeout(failure, budget);
        worker.postMessage({ deadline });
        return;
      }
      if (!cleanup()) return;
      if (this.#closed || result?.ok !== true) {
        reject(Object.assign(new Error("Provider settings snapshot rejected"), {
          phase: result?.phase === "validation" ? "validation" : "read", reason: "snapshot-invalid",
        }));
      } else resolve(result);
    };
    worker.on("message", receive); worker.once("error", failure); worker.once("exit", failure);
    this.#pending = { promise, cancel: failure };
    // Initialization has its own allowance. Later reads use only the operation budget.
    if (this.#readyWorker === worker) {
      timer = setTimeout(failure, 2_000);
      worker.postMessage({ deadline: Date.now() + 2_000 });
    } else {
      timer = setTimeout(failure, 5_000);
    }
    return promise;
  }
  #terminate(worker) {
    if (this.#terminating) return this.#terminating;
    // Windows must close its nested ACL helper before the outer thread exits.
    // A bounded caller wait may expire, but this task retains the physical owner.
    const exit = this.#workerExit;
    worker.postMessage({ operation: "close" });
    const fallback = process.platform === "win32" ? undefined : setTimeout(() => {
      if (this.#worker === worker) void worker.terminate().catch(() => {});
    }, 100);
    const task = exit.then(() => {
      if (this.#worker === worker) this.#worker = undefined;
    }).finally(() => {
      clearTimeout(fallback);
      // A failed termination retains ownership and blocks replacement until exit is confirmed.
      if (this.#worker !== worker && this.#terminating === task) this.#terminating = undefined;
    });
    this.#terminating = task;
    return task;
  }
  close() {
    this.#closed = true;
    this.#pending?.cancel();
    if (this.#closeTask) return this.#closeTask;
    const task = this.#terminating ?? (this.#worker ? this.#terminate(this.#worker) : undefined);
    if (!task) return Promise.resolve();
    let timer;
    this.#closeTask = Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Provider settings worker shutdown unconfirmed")), 2_000);
    })]).finally(() => { clearTimeout(timer); this.#closeTask = undefined; });
    return this.#closeTask;
  }
}
