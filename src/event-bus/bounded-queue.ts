interface WaitingConsumer<T> {
  resolve(value: T | undefined): void;
}

interface QueueEntry<T> {
  value: T;
  critical: boolean;
}

export class BoundedAsyncQueue<T> {
  private readonly entries: QueueEntry<T>[] = [];
  private readonly waiters: WaitingConsumer<T>[] = [];
  private closed = false;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error("队列容量必须是正整数");
    }
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
      this.entries.push({ value, critical });
      return true;
    }
    if (!critical) {
      return false;
    }
    const disposableIndex = this.entries.findIndex((entry) => !entry.critical);
    if (disposableIndex === -1) {
      return false;
    }
    this.entries.splice(disposableIndex, 1);
    this.entries.push({ value, critical });
    return true;
  }

  async shift(): Promise<T | undefined> {
    const entry = this.entries.shift();
    if (entry) {
      return entry.value;
    }
    if (this.closed) {
      return undefined;
    }
    return new Promise<T | undefined>((resolve) => this.waiters.push({ resolve }));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve(undefined);
    }
  }
}
