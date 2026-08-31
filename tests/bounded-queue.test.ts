import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  BoundedAsyncQueue,
  EventBus,
} from "../src/event-bus/index.js";

describe("BoundedAsyncQueue", () => {
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

  it("drains accepted entries before completing a closed queue", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    queue.push(1);
    queue.close();

    expect(queue.push(2)).toBe(false);
    expect(await queue.shift()).toBe(1);
    expect(await queue.shift()).toBeUndefined();
  });
});

describe("EventBus", () => {
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
