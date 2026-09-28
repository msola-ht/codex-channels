import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  BoundedAsyncQueue,
  EventBus,
} from "../src/event-bus/index.js";

describe("BoundedAsyncQueue", () => {
  it("reports an incomplete required EventBus drain instead of confirming successful close", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const bus = new EventBus<number>(pino({ level: "silent" }));
    bus.subscribe("blocked", () => pending);
    bus.publish(1, true);
    const closing = bus.close({ requireDrained: true });
    const rejected = expect(closing).rejects.toThrow("未排空");
    try { await vi.advanceTimersByTimeAsync(5000); await rejected; }
    finally { release(); vi.useRealTimers(); }
  });
  it("bounds open-bus drain and permits downstream publication afterward", async () => {
    vi.useFakeTimers();
    const bus = new EventBus<number>(pino({ level: "silent" }));
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const handled: number[] = [];
    bus.subscribe("consumer", async (event) => { if (event === 1) await pending; handled.push(event); });
    bus.publish(1, true);
    try {
      const rejected = expect(bus.drain()).rejects.toThrow("排空等待超时");
      await vi.advanceTimersByTimeAsync(5_000); await rejected;
      release(); await bus.drain();
      bus.publish(2, true); await bus.drain();
      expect(handled).toEqual([1, 2]);
    } finally { release(); await bus.close(); vi.useRealTimers(); }
  });

  it("removes only the selected entry while preserving capacity and priority ordering", async () => {
    const queue = new BoundedAsyncQueue<string>(3);
    queue.push("first", true);
    queue.push("cancelled");
    queue.push("last");
    expect(queue.remove("cancelled")).toBe(true);
    expect(queue.remove("cancelled")).toBe(false);
    queue.pushPriority("prompt");
    expect(queue.remove("prompt")).toBe(true);
    expect(queue.push("replacement")).toBe(true);
    expect(queue.size).toBe(3);
    expect(await queue.shift()).toBe("first");
    expect(await queue.shift()).toBe("last");
    expect(await queue.shift()).toBe("replacement");
  });

  it("requires a positive integer capacity", () => {
    expect(() => new BoundedAsyncQueue<number>(0)).toThrow(
      "队列容量必须是正整数",
    );
    expect(() => new BoundedAsyncQueue<number>(1.5)).toThrow(
      "队列容量必须是正整数",
    );
  });

  it("drops a non-critical event when full", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(false);
    expect(await queue.shift()).toBe(1);
  });

  it("replaces a queued non-critical event with a critical event", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    queue.push(1, false);
    expect(queue.push(2, true)).toBe(true);
    expect(await queue.shift()).toBe(2);
  });

  it("retains critical events when the queue contains only critical entries", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    expect(queue.push(1, true)).toBe(true);
    expect(queue.push(2, true)).toBe(true);
    expect(await queue.shift()).toBe(1);
    expect(await queue.shift()).toBe(2);
  });

  it("places priority after existing critical entries and before non-critical entries", async () => {
    const queue = new BoundedAsyncQueue<string>(4);
    queue.push("non-critical-1", false);
    queue.push("critical-1", true);
    queue.push("non-critical-2", false);

    expect(queue.pushPriority("interaction")).toBe(true);
    expect(await queue.shift()).toBe("critical-1");
    expect(await queue.shift()).toBe("interaction");
    expect(await queue.shift()).toBe("non-critical-1");
    expect(await queue.shift()).toBe("non-critical-2");
  });

  it("reports critical overflow at growing thresholds and rearms after recovery", async () => {
    const report = vi.fn();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const queue = new BoundedAsyncQueue<number>(2, report);
      queue.push(1, true);
      clock.mockReturnValue(1_500);
      for (let i = 2; i <= 6; i++) queue.pushPriority(i);
      expect(report.mock.calls.map(([state]) => state)).toEqual([
        { capacity: 2, queued: 3, oldestWaitMs: 500 },
        { capacity: 2, queued: 6, oldestWaitMs: 500 },
      ]);
      for (let i = 1; i <= 4; i++) expect(await queue.shift()).toBe(i);
      queue.push(7, true);
      expect(report).toHaveBeenCalledTimes(3);
      expect(report).toHaveBeenLastCalledWith({ capacity: 2, queued: 3, oldestWaitMs: 0 });
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps a large critical backlog when adding priority output", () => {
    const queue = new BoundedAsyncQueue<number>(2);
    for (let i = 0; i < 150_000; i++) queue.push(i, true);
    expect(queue.pushPriority(150_000)).toBe(true);
    expect(queue.size).toBe(150_001);
    queue.close();
  });

  it("drains accepted entries before completing a closed queue", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    queue.push(1);
    queue.close();

    expect(queue.push(2)).toBe(false);
    expect(await queue.shift()).toBe(1);
    expect(await queue.shift()).toBeUndefined();
  });

  it("replaces a pending entry with the same coalesce key in place", async () => {
    const queue = new BoundedAsyncQueue<string>(3);
    queue.push("first", true, "k");
    queue.push("other", true, "o");
    expect(queue.push("first-latest", true, "k")).toBe(true);
    expect(queue.size).toBe(2);
    expect(await queue.shift()).toBe("first-latest");
    expect(await queue.shift()).toBe("other");
  });

  it("keeps non-critical accounting consistent when coalescing changes criticality", () => {
    const queue = new BoundedAsyncQueue<string>(2);
    queue.push("non-critical", false, "k");
    expect(nonCriticalCount(queue)).toBe(1);
    queue.push("critical", true, "k");
    expect(nonCriticalCount(queue)).toBe(0);
    queue.push("non-critical-again", false, "k");
    expect(nonCriticalCount(queue)).toBe(1);
  });

  it("drops the coalesce key after the entry is shifted", async () => {
    const queue = new BoundedAsyncQueue<string>(2);
    queue.push("a", true, "k");
    expect(await queue.shift()).toBe("a");
    expect(queue.push("b", true, "k")).toBe(true);
    expect(queue.size).toBe(1);
    expect(await queue.shift()).toBe("b");
  });

  it("drops the coalesce key after the entry is removed", async () => {
    const queue = new BoundedAsyncQueue<string>(2);
    queue.push("a", true, "k");
    expect(queue.remove("a")).toBe(true);
    expect(queue.push("b", true, "k")).toBe(true);
    expect(queue.size).toBe(1);
    expect(await queue.shift()).toBe("b");
  });

  it("drops the coalesce key after the entry is evicted by overflow", async () => {
    const queue = new BoundedAsyncQueue<string>(1);
    queue.push("disposable", false, "k");
    queue.push("critical", true);
    expect(queue.size).toBe(1);
    expect(queue.push("replacement", true, "k")).toBe(true);
    // 已淘汰条目的键必须失效，否则新载荷会写入一个不在队列里的旧条目并丢失。
    expect(queue.size).toBe(2);
    expect(await queue.shift()).toBe("critical");
    expect(await queue.shift()).toBe("replacement");
  });

  it("reports coalesced replacements with the current queue depth", async () => {
    const coalesced: Array<{ coalesceKey: string; queued: number }> = [];
    const queue = new BoundedAsyncQueue<string>(
      3,
      undefined,
      (state) => coalesced.push(state),
    );
    queue.push("first", true, "k");
    expect(coalesced).toEqual([]);
    queue.push("other", true, "o");
    queue.push("latest", true, "k");
    expect(coalesced).toEqual([{ coalesceKey: "k", queued: 2 }]);
    expect(await queue.shift()).toBe("latest");
    expect(await queue.shift()).toBe("other");
  });
});

function nonCriticalCount<T>(queue: BoundedAsyncQueue<T>): number {
  return (queue as unknown as { nonCriticalCount: number }).nonCriticalCount;
}

describe("EventBus", () => {
  it("coalesces waiting snapshots independently for slow subscribers without blocking fast ones", async () => {
    const bus = new EventBus<{ value: number; key?: string }>(pino({ level: "silent" }), 2, (event) => event.key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: number[] = [];
    const fast: number[] = [];
    bus.subscribe("slow", async (event) => {
      if (event.value === 0) await gate;
      slow.push(event.value);
    });
    bus.subscribe("fast", (event) => { fast.push(event.value); });
    bus.publish({ value: 0 }, true);
    await Promise.resolve();
    for (let value = 1; value <= 100; value++) {
      bus.publish({ value, key: "snapshot" }, true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(fast).toHaveLength(101);
    expect(slow).toEqual([]);
    release();
    await bus.close();
    expect(slow).toEqual([0, 100]);
  });

  it("measures consumer backlog separately from handler execution", async () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus<number>(pino({ level: "silent" }));
      const waits: number[] = [];
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      bus.subscribe("timing", async (event, _signal, queueWaitMs) => {
        waits.push(queueWaitMs);
        if (event === 1) await gate;
      });
      bus.publish(1, true);
      await Promise.resolve();
      bus.publish(2, true);
      await vi.advanceTimersByTimeAsync(6000);
      release();
      await bus.close();
      expect(waits).toEqual([0, 6000]);
    } finally { vi.useRealTimers(); }
  });

  it("rejects new subscriptions after close", async () => {
    const bus = new EventBus<number>(pino({ level: "silent" }));
    await bus.close();

    expect(() => bus.subscribe("late", () => undefined)).toThrow(
      "事件总线已关闭",
    );
  });

  it("makes concurrent close callers wait for the same active consumer", async () => {
    const bus = new EventBus<number>(pino({ level: "silent" }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    bus.subscribe("slow", async () => {
      markStarted();
      await gate;
    });
    bus.publish(1, true);
    await started;

    const firstClose = bus.close();
    let secondFinished = false;
    const secondClose = bus.close().then(() => {
      secondFinished = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(secondFinished).toBe(false);

    release();
    await Promise.all([firstClose, secondClose]);
  });

  it("waits for an unsubscribed consumer during close", async () => {
    const bus = new EventBus<number>(pino({ level: "silent" }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unsubscribe = bus.subscribe("slow", async () => gate);
    bus.publish(1, true);
    unsubscribe();

    let closed = false;
    const closing = bus.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);

    release();
    await closing;
    expect(closed).toBe(true);
  });

  it("aborts an active consumer when closing", async () => {
    const bus = new EventBus<number>(pino({ level: "silent" }));
    let signal!: AbortSignal;
    bus.subscribe("signal", (_event, workerSignal) => {
      signal = workerSignal;
    });
    bus.publish(1, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await bus.close();
    expect(signal.aborted).toBe(true);
  });

  it("aborts an active consumer when unsubscribing", async () => {
    const bus = new EventBus<number>(pino({ level: "silent" }));
    let signal!: AbortSignal;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const unsubscribe = bus.subscribe("signal", async (_event, workerSignal) => {
      signal = workerSignal;
      started();
      await new Promise<void>((resolve) => {
        if (workerSignal.aborted) {
          resolve();
          return;
        }
        workerSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    bus.publish(1, true);
    await startedPromise;

    unsubscribe();
    await bus.close();

    expect(signal.aborted).toBe(true);
  });

  it("stops waiting after the consumer close timeout", async () => {
    vi.useFakeTimers();
    const bus = new EventBus<number>(pino({ level: "silent" }));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    bus.subscribe("stuck", async () => {
      markStarted();
      await gate;
    });
    bus.publish(1, true);
    await started;

    try {
      let closed = false;
      const closing = bus.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await closing;
      expect(closed).toBe(true);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("isolates consumer failures and continues every subscription", async () => {
    const bus = new EventBus<number>(pino({ level: "silent" }));
    const first: number[] = [];
    const second: number[] = [];
    bus.subscribe("first", (event) => {
      first.push(event);
      if (event === 1) {
        throw new Error("expected");
      }
    });
    bus.subscribe("second", (event) => {
      second.push(event);
    });

    bus.publish(1, true);
    bus.publish(2, true);
    await bus.close();

    expect(first).toEqual([1, 2]);
    expect(second).toEqual([1, 2]);
  });
});
