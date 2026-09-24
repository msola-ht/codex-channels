interface WaitingConsumer<T> {
  resolve(value: T | undefined): void;
}

interface QueueEntry<T> {
  value: T;
  critical: boolean;
  enqueuedAtMs: number;
}

interface QueueOverflow {
  capacity: number;
  queued: number;
  oldestWaitMs: number;
}

export class BoundedAsyncQueue<T> {
  private entries: QueueEntry<T>[] = [];
  private nonCriticalCount = 0;
  private readonly waiters: WaitingConsumer<T>[] = [];
  private closed = false;
  private nextOverflowWarning: number;

  constructor(
    readonly capacity: number,
    private readonly onOverflow?: (state: QueueOverflow) => void,
  ) {
    this.nextOverflowWarning = capacity + 1;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("队列容量必须是正整数");
    }
  }

  get size(): number {
    return this.entries.length;
  }

  push(value: T, critical = false): boolean {
    if (this.closed) {
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return true;
    }
    if (this.entries.length < this.capacity) {
      this.entries.push({ value, critical, enqueuedAtMs: Date.now() });
      if (!critical) this.nonCriticalCount += 1;
      return true;
    }
    if (!critical) {
      return false;
    }
    // 关键事件不能因普通容量耗尽而丢失；容量只限制可丢弃的中间事件。
    const disposableIndex = this.nonCriticalCount === 0
      ? -1 : this.entries.findIndex((entry) => !entry.critical);
    if (disposableIndex !== -1) {
      this.entries.splice(disposableIndex, 1);
      this.nonCriticalCount -= 1;
    }
    this.entries.push({ value, critical, enqueuedAtMs: Date.now() });
    this.reportOverflow();
    return true;
  }

  pushPriority(value: T): boolean {
    if (this.closed) {
      return false;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return true;
    }
    if (this.nonCriticalCount === 0) return this.push(value, true);
    if (this.entries.length >= this.capacity) {
      const firstNonCritical = this.entries.findIndex((entry) => !entry.critical);
      if (firstNonCritical !== -1) {
        this.entries.splice(firstNonCritical, 1);
        this.nonCriticalCount -= 1;
      }
    }
    const criticalEntries = this.entries.filter((entry) => entry.critical);
    const nonCriticalEntries = this.entries.filter((entry) => !entry.critical);
    this.entries = [
      ...criticalEntries,
      { value, critical: true, enqueuedAtMs: Date.now() },
      ...nonCriticalEntries,
    ];
    this.reportOverflow();
    return true;
  }

  async shift(): Promise<T | undefined> {
    const entry = this.entries.shift();
    if (this.size <= this.capacity) this.nextOverflowWarning = this.capacity + 1;
    if (entry) {
      if (!entry.critical) this.nonCriticalCount -= 1;
      return entry.value;
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<T | undefined>((resolve) => this.waiters.push({ resolve }));
  }

  remove(value: T): boolean {
    const index = this.entries.findIndex((entry) => entry.value === value);
    if (index < 0) return false;
    const [entry] = this.entries.splice(index, 1);
    if (!entry!.critical) this.nonCriticalCount -= 1;
    if (this.size <= this.capacity) this.nextOverflowWarning = this.capacity + 1;
    return true;
  }

  private reportOverflow(): void {
    if (this.size < this.nextOverflowWarning) return;
    this.nextOverflowWarning = this.size * 2;
    if (!this.onOverflow) return;
    const now = Date.now();
    let oldest = now;
    for (const entry of this.entries) oldest = Math.min(oldest, entry.enqueuedAtMs);
    this.onOverflow({ capacity: this.capacity, queued: this.size, oldestWaitMs: Math.max(0, now - oldest) });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(undefined);
    }
  }
}
