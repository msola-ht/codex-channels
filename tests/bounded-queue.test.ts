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

  it("never evicts a queued critical event for another event", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    expect(queue.push(1, true)).toBe(true);
    expect(queue.push(2, true)).toBe(false);
    expect(await queue.shift()).toBe(1);
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
