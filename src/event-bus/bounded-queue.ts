interface WaitingConsumer<T> {
  resolve(value: T | undefined): void;
}

interface QueueEntry<T> {
  value: T;
  critical: boolean;
  enqueuedAtMs: number;
  /** Pending entries that share a key keep only the newest payload. */
  coalesceKey?: string;
}

interface QueueOverflow {
  capacity: number;
  queued: number;
  oldestWaitMs: number;
}

interface QueueCoalesce {
  coalesceKey: string;
  queued: number;
}

export class BoundedAsyncQueue<T> {
  private entries: QueueEntry<T>[] = [];
  private nonCriticalCount = 0;
  private readonly pendingByCoalesceKey = new Map<string, QueueEntry<T>>();
  private readonly waiters: WaitingConsumer<T>[] = [];
  private closed = false;
  private nextOverflowWarning: number;

  constructor(
    readonly capacity: number,
    private readonly onOverflow?: (state: QueueOverflow) => void,
    private readonly onCoalesce?: (state: QueueCoalesce) => void,
    private readonly onDiscard?: (value: T, reason: "coalesced" | "capacity") => void,
  ) {
    this.nextOverflowWarning = capacity + 1;
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("队列容量必须是正整数");
    }
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * 入队一个条目。提供 coalesceKey 时，若同键条目仍在等待执行，则就地替换它的载荷，
   * 保持原有顺序、容量计数与等待时间；已在执行或已被丢弃的条目不受影响。
   */
  push(value: T, critical = false, coalesceKey?: string): boolean {
    if (this.closed) {
      return false;
    }
    if (coalesceKey !== undefined) {
      const pending = this.pendingByCoalesceKey.get(coalesceKey);
      if (pending !== undefined) {
        if (pending.critical !== critical) {
          pending.critical = critical;
          this.nonCriticalCount += critical ? -1 : 1;
        }
        this.onDiscard?.(pending.value, "coalesced");
        pending.value = value;
        this.onCoalesce?.({ coalesceKey, queued: this.entries.length });
        return true;
      }
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(value);
      return true;
    }
    if (this.entries.length < this.capacity) {
      this.entries.push(this.createEntry(value, critical, coalesceKey));
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
      const [disposable] = this.entries.splice(disposableIndex, 1);
      this.onDiscard?.(disposable!.value, "capacity");
      this.forgetCoalesceKey(disposable);
      this.nonCriticalCount -= 1;
    }
    this.entries.push(this.createEntry(value, critical, coalesceKey));
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
        const [disposable] = this.entries.splice(firstNonCritical, 1);
        this.onDiscard?.(disposable!.value, "capacity");
        this.forgetCoalesceKey(disposable);
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
      this.forgetCoalesceKey(entry);
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
    this.forgetCoalesceKey(entry);
    if (!entry!.critical) this.nonCriticalCount -= 1;
    if (this.size <= this.capacity) this.nextOverflowWarning = this.capacity + 1;
    return true;
  }

  private createEntry(value: T, critical: boolean, coalesceKey?: string): QueueEntry<T> {
    const entry: QueueEntry<T> = coalesceKey === undefined
      ? { value, critical, enqueuedAtMs: Date.now() }
      : { value, critical, enqueuedAtMs: Date.now(), coalesceKey };
    if (coalesceKey !== undefined) {
      this.pendingByCoalesceKey.set(coalesceKey, entry);
    }
    return entry;
  }

  private forgetCoalesceKey(entry: QueueEntry<T> | undefined): void {
    const key = entry?.coalesceKey;
    if (key === undefined) return;
    if (this.pendingByCoalesceKey.get(key) === entry) {
      this.pendingByCoalesceKey.delete(key);
    }
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
    this.pendingByCoalesceKey.clear();
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(undefined);
    }
  }
}
