import { DeliveryJournal } from "./journal.js";
import { defaultDeliveryLimits, DeliveryError, type DeliveryRecord, type DeliverySubmission } from "./types.js";

export interface DeliveryCoordinatorOptions {
  accounts(): string[];
  authorized(record: DeliveryRecord): boolean | Promise<boolean>;
  deliver(record: DeliveryRecord, signal: AbortSignal): Promise<void>;
  fault(code: string, account?: string): void;
  concurrency?: number;
  timeoutMs?: number;
  changed?(): void;
}

/** Owns scheduling only. Payloads and platform semantics belong to the caller. */
export class DeliveryCoordinator {
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly outstanding = new Map<string, number>();
  private readonly submissions = new Set<Promise<void>>();
  private started = false;
  private stopped = false;
  private pumping = false;
  private dirty = false;
  private closePromise: Promise<void> | undefined;
  private startPromise: Promise<void> | undefined;
  private readonly usage = new Map<string, { bytes: number; records: number; paused: boolean }>();
  private readonly total = { bytes: 0, records: 0, paused: false };

  constructor(readonly journal: DeliveryJournal, private readonly options: DeliveryCoordinatorOptions) {}

  start(): Promise<void> {
    this.startPromise ??= this.initialize();
    return this.startPromise;
  }

  private async initialize(): Promise<void> {
    await this.journal.ready;
    let after = 0;
    while (true) {
      const page = await this.journal.list(after);
      for (const row of page) {
        this.updateUsage(row.account, row.bytes, 1);
        this.outstanding.set(row.conversation, (this.outstanding.get(row.conversation) ?? 0) + 1);
        after = row.sequence;
      }
      if (page.length < 100) break;
    }
    // A restart must not erase a previous high-water pause. At an intermediate
    // occupancy, conservatively wait until the documented low watermark.
    this.total.paused = Math.max(this.total.bytes / defaultDeliveryLimits.bytes, this.total.records / defaultDeliveryLimits.records) >= 0.6;
    for (const usage of this.usage.values()) usage.paused = Math.max(usage.bytes / defaultDeliveryLimits.accountBytes, usage.records / defaultDeliveryLimits.accountRecords) >= 0.6;
    this.started = true;
    this.wake();
  }

  hasOutstanding(conversation: string): boolean { return this.outstanding.has(conversation); }

  acceptsExecution(account: string): boolean {
    return this.started && !this.stopped && !this.total.paused && !this.usage.get(account)?.paused;
  }

  submit(value: DeliverySubmission): Promise<void> {
    if (this.stopped || !this.started) { this.options.fault("closed", value.account); return Promise.resolve(); }
    if (this.submissions.size >= 128) { this.options.fault("mailbox-full", value.account); return Promise.resolve(); }
    this.outstanding.set(value.conversation, (this.outstanding.get(value.conversation) ?? 0) + 1);
    const bytes = Buffer.byteLength(value.payload) + 64 * 1024;
    this.updateUsage(value.account, bytes, 1);
    const task = this.journal.submit(value).then(() => this.wake(), (error: unknown) => {
      this.release(value.conversation);
      this.updateUsage(value.account, -bytes, -1);
      this.options.fault(error instanceof DeliveryError ? error.code : "storage", value.account);
    });
    this.submissions.add(task);
    void task.finally(() => this.submissions.delete(task));
    return task;
  }

  wake(): void {
    this.dirty = true;
    if (!this.started || this.stopped || this.pumping) return;
    this.pumping = true;
    void this.pump().catch(() => {
      if (!this.stopped) { this.stopped = true; this.options.fault("storage"); }
    }).finally(() => {
      this.pumping = false;
      if (this.dirty && !this.stopped) this.wake();
    });
  }

  private async pump(): Promise<void> {
    do {
      this.dirty = false;
      while (!this.stopped && this.active.size < (this.options.concurrency ?? 8)) {
        const accounts = this.options.accounts();
        if (accounts.length === 0) break;
        const record = await this.journal.next([...this.active.keys()], accounts);
        if (!record || this.stopped) break;
        const controller = new AbortController();
        const task = this.run(record, controller).finally(() => {
          this.active.delete(record.conversation);
          this.wake();
        });
        this.active.set(record.conversation, { controller, task });
      }
    } while (this.dirty && !this.stopped);
  }

  private async run(record: DeliveryRecord, controller: AbortController): Promise<void> {
    let cancel!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new DeliveryError("closed"));
      controller.signal.addEventListener("abort", cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    try {
      if (!(await Promise.race([this.options.authorized(record), cancelled]))) {
        await this.journal.transition(record.id, "pending", "blocked");
        this.options.fault("authorization-changed", record.account);
        return;
      }
      if (this.stopped) return;
      if (!(await this.journal.transition(record.id, "pending", "sending"))) throw new DeliveryError("conflict");
      try {
        controller.signal.throwIfAborted();
        await Promise.race([
          this.options.deliver(record, controller.signal),
          cancelled,
        ]);
        controller.signal.throwIfAborted();
        if (!(await this.journal.acknowledge(record.id))) throw new DeliveryError("conflict");
        this.release(record.conversation);
        this.updateUsage(record.account, -record.bytes, -1);
      } catch {
        await this.journal.transition(record.id, "sending", "uncertain");
        this.options.fault("delivery-uncertain", record.account);
      }
    } catch { if (!this.stopped) this.options.fault("storage", record.account); }
    finally { clearTimeout(timer); controller.signal.removeEventListener("abort", cancel); }
  }

  private release(conversation: string): void {
    const count = (this.outstanding.get(conversation) ?? 1) - 1;
    if (count <= 0) this.outstanding.delete(conversation);
    else this.outstanding.set(conversation, count);
    this.options.changed?.();
  }

  private updateUsage(account: string, bytes: number, records: number): void {
    const usage = this.usage.get(account) ?? { bytes: 0, records: 0, paused: false };
    usage.bytes += bytes;
    usage.records += records;
    this.total.bytes += bytes;
    this.total.records += records;
    const pressure = (value: typeof usage, maxBytes: number, maxRecords: number): void => {
      const ratio = Math.max(value.bytes / maxBytes, value.records / maxRecords);
      if (ratio >= 0.8) value.paused = true;
      else if (ratio < 0.6) value.paused = false;
    };
    pressure(usage, defaultDeliveryLimits.accountBytes, defaultDeliveryLimits.accountRecords);
    pressure(this.total, defaultDeliveryLimits.bytes, defaultDeliveryLimits.records);
    if (usage.records === 0) this.usage.delete(account);
    else this.usage.set(account, usage);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.stopped = true;
    for (const { controller } of this.active.values()) controller.abort();
    this.closePromise = (async () => {
      await Promise.allSettled([...this.submissions, ...[...this.active.values()].map((entry) => entry.task)]);
      await this.journal.close();
    })();
    return this.closePromise;
  }
}
