import { Worker } from "node:worker_threads";
import { DeliveryError, type DeliveryFailure, type DeliveryLimits, type DeliveryQueueEntry, type DeliveryRecord, type DeliveryState, type DeliverySubmission, type DeliverySummary, type JournalCommand, type JournalResult, type WorkerReply } from "./types.js";

const journals = new Map<DeliveryJournal, Promise<void>>();
let closingJournals = false;

/** Retain every writer until its Worker (and nested helper) actually exits. */
export async function closeDeliveryJournals(): Promise<void> {
  closingJournals = true;
  const results = await Promise.allSettled([...journals.keys()].map(journal => journal.close()));
  if (results.some(result => result.status === "rejected")) throw new DeliveryError("storage");
}

export async function waitForDeliveryJournalsExit(): Promise<void> {
  await Promise.all([...journals.values()]);
}

export class DeliveryJournal {
  private readonly worker: Worker;
  private readonly cancellation = new Int32Array(new SharedArrayBuffer(4));
  private readonly exit: Promise<void>;
  private exited = false;
  private shutdownPromise: Promise<void> | undefined;
  private readonly pending = new Map<number, { resolve(value: JournalResult): void; reject(error: Error): void; bytes: number; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private bytes = 0;
  private closing = false;
  private failed = false;
  private closePromise: Promise<void> | undefined;
  private failureDetail: DeliveryFailure | undefined;
  readonly ready: Promise<void>;
  get failure(): DeliveryFailure | undefined { return this.failureDetail; }

  /** Liveness only; callers must still await ready before accepting work. */
  get available(): boolean { return !this.failed && !this.closing; }

  constructor(directory: string, private readonly options: { limits?: DeliveryLimits; workerUrl?: URL; onFailure?(failure: DeliveryFailure): void; mode?: "runtime" | "maintenance" } = {}) {
    if (closingJournals) throw new DeliveryError("closed");
    this.worker = new Worker(options.workerUrl ?? new URL("./worker.js", import.meta.url), { workerData: { directory, limits: options.limits, mode: options.mode, cancellation: this.cancellation } });
    this.exit = new Promise(resolve => this.worker.once("exit", () => { this.exited = true; journals.delete(this); resolve(); }));
    journals.set(this, this.exit);
    this.ready = new Promise<void>((resolve, reject) => {
      // Windows initialization performs multiple bounded ACL subprocess calls.
      // Give startup its own budget; ordinary journal requests stay at 5 seconds.
      this.pending.set(0, { resolve: () => resolve(), reject, bytes: 0, timer: this.deadline("startup", undefined, process.platform === "win32" ? 30_000 : 5_000) });
    });
    // Startup failure is also observed by the composition root through ready.
    void this.ready.catch(() => {});
    this.worker.on("message", (reply: WorkerReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      clearTimeout(pending.timer);
      this.bytes -= pending.bytes;
      if (reply.ok) pending.resolve(reply.result);
      else {
        this.failureDetail = reply.failure;
        pending.reject(new DeliveryError(reply.code));
        if (reply.id === 0 || reply.code === "storage") this.fail(reply.failure);
      }
    });
    this.worker.on("error", () => this.fail({ phase: "worker", reason: "worker-error" }));
    this.worker.on("exit", () => { if (this.pending.size > 0 || !this.closing) this.fail({ phase: "worker", reason: "worker-exit" }); });
  }

  submit(value: DeliverySubmission): Promise<number> { return this.call({ type: "submit", value }) as Promise<number>; }
  next(excluded: string[] = [], accounts?: string[]): Promise<DeliveryRecord | null> {
    return this.call({ type: "next", excluded, ...(accounts ? { accounts } : {}) }) as Promise<DeliveryRecord | null>;
  }
  read(id: string): Promise<DeliveryRecord | null> { return this.call({ type: "read", id }) as Promise<DeliveryRecord | null>; }
  queueEntry(id: string): Promise<DeliveryQueueEntry | null> { return this.call({ type: "queueEntry", id }) as Promise<DeliveryQueueEntry | null>; }
  queueEntries(ids: string[]): Promise<Array<DeliveryQueueEntry | null>> { return this.call({ type: "queueEntries", ids }) as Promise<Array<DeliveryQueueEntry | null>>; }
  releaseBarrier(id: string): Promise<boolean> { return this.call({ type: "releaseBarrier", id }) as Promise<boolean>; }
  transition(id: string, from: DeliveryState, to: DeliveryState): Promise<boolean> { return this.call({ type: "state", id, from, to }) as Promise<boolean>; }
  acknowledge(id: string): Promise<boolean> { return this.call({ type: "acknowledge", id }) as Promise<boolean>; }
  checkpoint(id: string, value: DeliveryRecord["progress"][number]): Promise<boolean> { return this.call({ type: "checkpoint", id, value }) as Promise<boolean>; }
  summary(): Promise<DeliverySummary> { return this.call({ type: "summary" }) as Promise<DeliverySummary>; }
  list(after = 0, limit = 100): Promise<Array<Omit<DeliveryRecord, "payload">>> { return this.call({ type: "list", after, limit }) as Promise<Array<Omit<DeliveryRecord, "payload">>>; }
  resolve(id: string, action: "retry" | "confirm"): Promise<boolean> { return this.call({ type: "resolve", id, action }) as Promise<boolean>; }

  resolveBatch(entries: Array<{ id: string; revision: string }>, action: "retry" | "confirm"): Promise<boolean> { return this.call({ type: "resolveBatch", entries, action }) as Promise<boolean>; }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    if (this.pending.has(0)) this.fail({ phase: "startup", reason: "storage", operation: "close" });
    if (this.failed) {
      this.closePromise = this.shutdown();
      return this.closePromise;
    }
    this.closePromise = (async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.call({ type: "close" }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryError("storage")), 5_000); }),
        ]);
      } finally {
        clearTimeout(timer);
        this.fail();
        await this.shutdown();
      }
    })();
    return this.closePromise;
  }

  private call(command: JournalCommand): Promise<JournalResult> {
    if (this.failed || (this.closing && command.type !== "close")) return Promise.reject(new DeliveryError("closed"));
    const bytes = command.type === "submit" ? Buffer.byteLength(command.value.payload) : 0;
    // The control path has reserved slots, so acknowledgements and close can drain a saturated mailbox.
    if (this.pending.size >= (["submit", "queueEntries", "resolveBatch"].includes(command.type) ? 128 : 160) || this.bytes + bytes > 8 * 1024 * 1024) return Promise.reject(new DeliveryError("mailbox-full"));
    const id = this.nextId++;
    this.bytes += bytes;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, bytes, timer: this.deadline("request", command.type) });
      try { this.worker.postMessage({ id, command }); }
      catch { this.fail({ phase: "request", reason: "message", operation: command.type }); }
    });
  }

  private fail(failure: DeliveryFailure = { phase: "worker", reason: "storage" }): void {
    const notify = !this.failed && !this.closing;
    if (!this.failed) this.failureDetail = failure;
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DeliveryError("storage"));
    }
    this.pending.clear();
    this.bytes = 0;
    void this.shutdown().catch(() => {});
    if (notify) this.options.onFailure?.(failure);
  }

  private deadline(phase: DeliveryFailure["phase"], operation?: JournalCommand["type"], timeoutMs = 5_000): NodeJS.Timeout {
    return setTimeout(() => {
      this.fail({ phase, reason: "timeout", ...(operation ? { operation } : {}) });
    }, timeoutMs);
  }

  private shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    Atomics.store(this.cancellation, 0, 1);
    this.shutdownPromise = (async () => {
      if (this.exited) return;
      this.worker.postMessage({ id: -1, command: { type: "close" } });
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.exit,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryError("storage")), 2_000); }),
        ]);
      } catch (error) {
        // Windows must cooperatively close its nested ACL helper. Keep this
        // Worker referenced after timeout rather than orphaning that helper.
        if (process.platform !== "win32" && !this.exited) void this.worker.terminate().catch(() => {});
        throw error;
      } finally { clearTimeout(timer); }
    })();
    return this.shutdownPromise;
  }
}
