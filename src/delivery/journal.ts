import { Worker } from "node:worker_threads";
import { DeliveryError, type DeliveryLimits, type DeliveryQueueEntry, type DeliveryRecord, type DeliveryState, type DeliverySubmission, type DeliverySummary, type JournalCommand, type JournalResult, type WorkerReply } from "./types.js";

// Keep node:sqlite out of CLI imports that only construct a Worker journal.
export async function readDeliveryQueue(directory: string, options?: { before?: number; state?: DeliveryState; id?: string }) {
  return (await import("./queue-reader.js")).readDeliveryQueue(directory, options);
}

export async function readDeliveryPayload(directory: string, id: string) {
  return (await import("./queue-reader.js")).readDeliveryPayload(directory, id);
}

export class DeliveryJournal {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve(value: JournalResult): void; reject(error: Error): void; bytes: number; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private bytes = 0;
  private closing = false;
  private failed = false;
  private closePromise: Promise<void> | undefined;
  readonly ready: Promise<void>;

  /** Liveness only; callers must still await ready before accepting work. */
  get available(): boolean { return !this.failed && !this.closing; }

  constructor(directory: string, private readonly options: { limits?: DeliveryLimits; workerUrl?: URL; onFailure?(): void; mode?: "runtime" | "maintenance" } = {}) {
    this.worker = new Worker(options.workerUrl ?? new URL("./worker.js", import.meta.url), { workerData: { directory, limits: options.limits, mode: options.mode } });
    this.ready = new Promise<void>((resolve, reject) => {
      this.pending.set(0, { resolve: () => resolve(), reject, bytes: 0, timer: this.deadline() });
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
        pending.reject(new DeliveryError(reply.code));
        if (reply.id === 0) { this.fail(); void this.terminate().catch(() => {}); }
      }
    });
    this.worker.on("error", () => this.fail());
    this.worker.on("exit", () => { if (this.pending.size > 0 || !this.closing) this.fail(); });
  }

  submit(value: DeliverySubmission): Promise<number> { return this.call({ type: "submit", value }) as Promise<number>; }
  next(excluded: string[] = [], accounts?: string[]): Promise<DeliveryRecord | null> {
    return this.call({ type: "next", excluded, ...(accounts ? { accounts } : {}) }) as Promise<DeliveryRecord | null>;
  }
  read(id: string): Promise<DeliveryRecord | null> { return this.call({ type: "read", id }) as Promise<DeliveryRecord | null>; }
  queueEntry(id: string): Promise<DeliveryQueueEntry | null> { return this.call({ type: "queueEntry", id }) as Promise<DeliveryQueueEntry | null>; }
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
    if (this.failed) {
      this.closePromise = this.terminate();
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
        await this.terminate();
        this.fail();
      }
    })();
    return this.closePromise;
  }

  private call(command: JournalCommand): Promise<JournalResult> {
    if (this.failed || (this.closing && command.type !== "close")) return Promise.reject(new DeliveryError("closed"));
    const bytes = command.type === "submit" ? Buffer.byteLength(command.value.payload) : 0;
    // The control path has reserved slots, so acknowledgements and close can drain a saturated mailbox.
    if (this.pending.size >= (command.type === "submit" ? 128 : 160) || this.bytes + bytes > 8 * 1024 * 1024) return Promise.reject(new DeliveryError("mailbox-full"));
    const id = this.nextId++;
    this.bytes += bytes;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, bytes, timer: this.deadline() });
      try { this.worker.postMessage({ id, command }); }
      catch { this.fail(); }
    });
  }

  private fail(): void {
    const notify = !this.failed && !this.closing;
    this.failed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new DeliveryError("storage"));
    }
    this.pending.clear();
    this.bytes = 0;
    if (notify) this.options.onFailure?.();
  }

  private deadline(): NodeJS.Timeout {
    return setTimeout(() => {
      this.fail();
      void this.terminate().catch(() => {});
    }, 5_000);
  }

  private async terminate(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    this.worker.unref();
    try {
      await Promise.race([
        this.worker.terminate(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DeliveryError("storage")), 1_000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
}
