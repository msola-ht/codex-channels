import { Worker } from "node:worker_threads";

const readers = new Set();
let closing = false;

/** Final process shutdown closes admission before waiting for existing owners. */
export async function closeSingleWorkerReaders() {
  closing = true;
  const results = await Promise.allSettled([...readers].map(reader => reader.close()));
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "Material workers shutdown unconfirmed");
}

export function waitForSingleWorkerReadersExit() {
  return Promise.all([...readers].map(reader => reader.waitForExit())).then(() => undefined);
}

/** One owned material Worker; caller timeout never releases physical ownership. */
export class SingleWorkerReader {
  #worker;
  #pending;
  #terminating;
  #closeTask;
  #readyWorker;
  #workerExit;
  #closed = false;
  constructor(options) { this.options = options; readers.add(this); }
  async readFresh() {
    await this.#pending?.promise.catch(() => undefined);
    return this.read();
  }
  read() {
    if (closing || this.#closed || this.#terminating) return Promise.reject(this.options.errors.unavailable());
    if (this.#pending) return this.#pending.promise;
    if (!this.#worker) {
      const worker = new Worker(this.options.workerUrl, {
        workerData: this.options.workerData(),
        resourceLimits: { maxOldGenerationSizeMb: 64 },
      });
      worker.on("error", () => {});
      this.#workerExit = new Promise(resolve => worker.once("exit", resolve));
      worker.on("exit", () => {
        if (this.#worker === worker) {
          this.#worker = undefined;
          this.#terminating = undefined;
          if (this.#closed) readers.delete(this);
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
      reject(this.options.errors.failure(this.#readyWorker === worker ? "read" : "initialization"));
      void this.#terminate(worker).catch(() => {});
    };
    const receive = result => {
      if (result?.ready === true) {
        this.#readyWorker = worker;
        clearTimeout(timer);
        // The first Windows snapshot also initializes the owned ACL bridge (up to 5 s).
        // This allowance never applies to later ordinary reads or shutdown.
        const budget = process.platform === "win32" ? 7_000 : this.options.readTimeoutMs();
        timer = setTimeout(failure, budget);
        sendRead(budget);
        return;
      }
      if (!cleanup()) return;
      if (this.#closed || result?.ok !== true) {
        reject(this.options.errors.invalid(result));
      } else resolve(result);
    };
    const sendRead = budget => {
      try { worker.postMessage({ operation: "read", deadline: Date.now() + budget }); }
      catch { failure(); }
    };
    worker.on("message", receive); worker.once("error", failure); worker.once("exit", failure);
    this.#pending = { promise, cancel: failure };
    // Initialization has its own allowance. Later reads use only the operation budget.
    if (this.#readyWorker === worker) {
      const budget = this.options.readTimeoutMs();
      timer = setTimeout(failure, budget);
      sendRead(budget);
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
    // A send failure does not prove exit; retain the exit promise and owner.
    try { worker.postMessage({ operation: "close" }); } catch { /* Wait for physical exit. */ }
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
    if (!task) { readers.delete(this); return Promise.resolve(); }
    let timer;
    this.#closeTask = Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(this.options.errors.shutdown()), 2_000);
    })]).finally(() => { clearTimeout(timer); this.#closeTask = undefined; });
    return this.#closeTask;
  }
  waitForExit() {
    return this.#workerExit?.then(() => undefined) ?? Promise.resolve();
  }
}
