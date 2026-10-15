import { Worker } from "node:worker_threads";
import { ScheduledTaskStateError, type ScheduledTaskStore } from "./types.js";
import { ScheduledTaskStoreClosedError } from "./sqlite-store.js";
import {
  scheduledTaskWorkerMethods,
  type ScheduledTaskWorkerMethod,
  type ScheduledTaskWorkerReply,
  type ScheduledTaskWorkerRequest,
} from "./sqlite-worker-protocol.js";

const stores = new Map<AsyncSqliteScheduledTaskStore, Promise<void>>();
let closingStores = false;

export async function closeScheduledTaskStores(): Promise<void> {
  closingStores = true;
  const results = await Promise.allSettled([...stores.keys()].map(store => store.close()));
  if (results.some(result => result.status === "rejected")) throw new ScheduledTaskStorageError("shutdown", "close-unconfirmed");
}

export async function waitForScheduledTaskStoresExit(): Promise<void> {
  await Promise.all([...stores.values()]);
}

type AsyncMethods = {
  [K in ScheduledTaskWorkerMethod]: (...args: Parameters<ScheduledTaskStore[K]>) => Promise<ReturnType<ScheduledTaskStore[K]>>;
};

export class ScheduledTaskStorageError extends Error {
  readonly code = "scheduled-task.storage.unavailable";
  constructor(
    readonly phase: "initialization" | "request" | "shutdown",
    readonly reason: string,
    readonly operation?: ScheduledTaskWorkerMethod,
  ) {
    super("计划任务存储暂不可用");
    this.name = "ScheduledTaskStorageError";
  }
}

/** One owned Worker is the runtime's sole scheduled-task database connection. */
export class AsyncSqliteScheduledTaskStore {
  readonly operations: AsyncMethods & { readonly path: string; close(): Promise<void> };
  private readonly worker: Worker;
  private readonly cancellation = new Int32Array(new SharedArrayBuffer(4));
  private readonly initialized: Promise<void>;
  private resolveInitialization!: () => void;
  private rejectInitialization!: (error: Error) => void;
  private readonly initializationTimer: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<number, {
    method: ScheduledTaskWorkerMethod;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private nextId = 1;
  private admitted = 0;
  private admittedBytes = 0;
  private unavailable = false;
  private initializedSuccessfully = false;
  private closed = false;
  private readonly exit: Promise<void>;
  private exited = false;
  private closeAcknowledged = false;
  private closeTask: Promise<void> | undefined;

  constructor(readonly path: string) {
    if (closingStores) throw new ScheduledTaskStoreClosedError();
    this.initialized = new Promise((resolve, reject) => {
      this.resolveInitialization = resolve;
      this.rejectInitialization = reject;
    });
    void this.initialized.catch(() => undefined);
    this.worker = new Worker(new URL("./sqlite-worker.js", import.meta.url), { workerData: { path, cancellation: this.cancellation }, execArgv: [] });
    this.worker.on("message", (reply: ScheduledTaskWorkerReply) => this.receive(reply));
    this.worker.on("error", () => this.fail(new ScheduledTaskStorageError(this.initializedSuccessfully ? "request" : "initialization", "worker-error")));
    this.exit = new Promise(resolve => this.worker.once("exit", () => {
      this.exited = true;
      stores.delete(this);
      this.fail(new ScheduledTaskStorageError(this.initializedSuccessfully ? "request" : "initialization", "worker-exited"));
      resolve();
    }));
    stores.set(this, this.exit);
    this.initializationTimer = setTimeout(() => {
      this.fail(new ScheduledTaskStorageError("initialization", "timeout"));
    }, 10_000);
    this.operations = { ...Object.fromEntries(scheduledTaskWorkerMethods.map((method) => [
      method, (...args: unknown[]) => this.request(method, args),
    ])) as AsyncMethods, path, close: () => this.close() };
  }

  ready(): Promise<void> {
    return this.initialized;
  }

  private async request(method: ScheduledTaskWorkerMethod, args: unknown[]): Promise<unknown> {
    if (this.closed) throw new ScheduledTaskStoreClosedError();
    if (this.unavailable) throw new ScheduledTaskStorageError("request", "worker-unavailable", method);
    const bytes = Buffer.byteLength(JSON.stringify(args), "utf8");
    if (bytes > 256 * 1024 || this.admitted >= 128 || this.admittedBytes + bytes > 2 * 1024 * 1024) {
      throw new ScheduledTaskStorageError("request", "capacity", method);
    }
    this.admitted += 1;
    this.admittedBytes += bytes;
    try {
      await this.initialized;
      if (this.closed) throw new ScheduledTaskStoreClosedError();
      if (this.unavailable) throw new ScheduledTaskStorageError("request", "worker-unavailable", method);
      const id = this.nextId++;
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          // A timed-out write may have committed. Never retry it or replace
          // this connection; crash recovery retains unresolved claims.
          this.fail(new ScheduledTaskStorageError("request", "timeout", method));
        }, 6_000);
        this.pending.set(id, { method, resolve, reject, timer });
        try {
          this.worker.postMessage({ id, method, args });
        } catch {
          this.fail(new ScheduledTaskStorageError("request", "worker-unavailable", method));
        }
      });
    } finally {
      this.admitted -= 1;
      this.admittedBytes -= bytes;
    }
  }

  private receive(reply: ScheduledTaskWorkerReply): void {
    if ("type" in reply) { this.closeAcknowledged = reply.ok; return; }
    if (this.closed || this.unavailable) return;
    if (reply.id === 0) {
      clearTimeout(this.initializationTimer);
      if (reply.ok) {
        this.initializedSuccessfully = true;
        this.resolveInitialization();
      }
      else this.fail(new ScheduledTaskStorageError("initialization", reply.reason));
      return;
    }
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    clearTimeout(pending.timer);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(reply.reason === "state"
      ? new ScheduledTaskStateError(reply.stateMessage ?? "计划任务状态已变化")
      : new ScheduledTaskStorageError("request", reply.reason, pending.method));
  }

  private fail(error: Error): void {
    if (this.unavailable) return;
    this.unavailable = true;
    clearTimeout(this.initializationTimer);
    this.rejectInitialization(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    void this.shutdown().catch(() => undefined);
  }

  private shutdown(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    Atomics.store(this.cancellation, 0, 1);
    this.closeTask = (async () => {
      if (!this.exited) {
        try { this.worker.postMessage({ type: "close" } satisfies ScheduledTaskWorkerRequest); }
        catch { /* An unavailable channel still requires physical exit confirmation. */ }
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.exit,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new ScheduledTaskStorageError("shutdown", "exit-unconfirmed")), 2_000);
          }),
        ]);
        if (this.initializedSuccessfully && !this.closeAcknowledged) {
          throw new ScheduledTaskStorageError("shutdown", "close-unconfirmed");
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().finally(() => { this.closeTask = undefined; });
    return this.closeTask;
  }

  close(): Promise<void> {
    this.closed = true;
    this.fail(new ScheduledTaskStoreClosedError());
    return this.shutdown();
  }
}
