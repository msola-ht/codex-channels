import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ConversationDeliveryQueue } from "../src/surfaces/index.js";

const logger = pino({ level: "silent" });

describe("ConversationDeliveryQueue", () => {
  it("tracks asynchronous input replies and exposes their platform failure to the durable owner", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test" });
    const handle = async (): Promise<void> => {
      await new Promise<void>(resolve => setImmediate(resolve));
      delivery.enqueue("a", async () => { throw new Error("delivery failed"); }, true);
    };
    try { await expect(delivery.track("a", handle)).rejects.toThrow("delivery failed"); }
    finally { await delivery.close(); }
  });

  it("tracks actual completion, rejects overload and cancels queued tracked work on close", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test", capacity: 1 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const completed = vi.fn();
    const first = delivery.track("a", () => { delivery.enqueue("a", async () => { await gate; }, true); }).then(completed);
    await settle();
    expect(completed).not.toHaveBeenCalled();
    const pending = delivery.track("a", () => { delivery.enqueue("a", vi.fn(async () => {}), true); });
    const rejectedPending = expect(pending).rejects.toThrow("未完成");
    await expect(delivery.track("a", () => { delivery.enqueue("a", vi.fn(async () => {}), true); })).rejects.toThrow("未完成");
    const rejectedFirst = expect(first).rejects.toThrow("未完成");
    const closing = delivery.close();
    release();
    await rejectedFirst;
    await rejectedPending;
    await closing;
    expect(completed).not.toHaveBeenCalled();
  });

  it("reports slow queue waits and failed ordered work without exposing error text", async () => {
    vi.useFakeTimers();
    const entries: Array<Record<string, unknown>> = [];
    const log = pino({ level: "debug" }, { write: value => { entries.push(JSON.parse(value)); } });
    const delivery = new ConversationDeliveryQueue(log, { component: "Test" });
    let release!: () => void;
    delivery.enqueue("a", () => new Promise<void>(resolve => { release = resolve; }), true);
    const pending = delivery.runOrdered("a", async () => { throw new Error("secret-payload"); });
    const rejected = expect(pending).rejects.toThrow("secret-payload");
    try {
      await vi.advanceTimersByTimeAsync(6_000);
      release();
      await rejected;
      await delivery.close();
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ msg: "Surface Conversation 输出排队延迟", queueWaitMs: 6_000, queued: 0 }),
        expect.objectContaining({ msg: "Surface Conversation 输出任务已结束", outcome: "failed" }),
        expect.objectContaining({ msg: "Surface Conversation 输出执行缓慢", outcome: "completed" }),
      ]));
      expect(JSON.stringify(entries)).not.toContain("secret-payload");
    } finally { vi.useRealTimers(); }
  });

  it("shares one deadline across fragments and releases the Conversation after cancellation", async () => {
    vi.useFakeTimers();
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test", operationTimeoutMs: 100 });
    const calls: string[] = [];
    delivery.enqueue("a", async signal => {
      for (let index = 0; index < 3; index++) {
        signal.throwIfAborted();
        calls.push(`fragment:${index}`);
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, 60);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }, true);
    delivery.enqueue("a", async signal => { signal.throwIfAborted(); calls.push("next"); }, true);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(calls).toEqual(["fragment:0", "fragment:1", "next"]);
      await delivery.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a cancelled ordered operation without blocking later work", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test" });
    let release!: () => void;
    delivery.enqueue("a", () => new Promise<void>((resolve) => { release = resolve; }), true);
    await settle();
    const controller = new AbortController();
    const cancelled = vi.fn(async () => 1);
    const first = delivery.runOrdered("a", cancelled, controller.signal);
    const rejected = expect(first).rejects.toThrow("已取消");
    controller.abort();
    await rejected;
    const next = delivery.runOrdered("a", async () => 2);
    release();
    await expect(next).resolves.toBe(2);
    expect(cancelled).not.toHaveBeenCalled();
    await delivery.close();
  });

  it("settles ordered waiters and never starts queued work after the close deadline", async () => {
    vi.useFakeTimers();
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test", closeTimeoutMs: 10 });
    let release!: () => void;
    const inFlight = delivery.runOrdered("a", () => new Promise<void>((resolve) => { release = resolve; }));
    const rejectedInFlight = expect(inFlight).rejects.toThrow("已取消");
    await settle();
    const queued = vi.fn(async () => 42);
    const ordered = delivery.runOrdered("a", queued);
    const rejectedOrdered = expect(ordered).rejects.toThrow("已取消");
    const output = vi.fn(async () => undefined);
    delivery.enqueue("a", output, true);
    try {
      const close = delivery.close();
      await vi.advanceTimersByTimeAsync(10);
      await close;
      await Promise.all([rejectedInFlight, rejectedOrdered]);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(queued).not.toHaveBeenCalled();
      expect(output).not.toHaveBeenCalled();
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("drains ordinary output while cancelling ordered interactions immediately", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test", drainOnClose: true });
    let requestSignal: AbortSignal | undefined;
    const interaction = delivery.runOrdered("a", signal => new Promise<void>(resolve => {
      requestSignal = signal;
      signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const rejected = expect(interaction).rejects.toThrow("已取消");
    const sent = vi.fn(async (signal: AbortSignal) => { expect(signal.aborted).toBe(false); });
    delivery.enqueue("a", sent, true);
    await settle();
    await delivery.close();
    await rejected;
    expect(requestSignal?.aborted).toBe(true);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("cancels a draining request at the close deadline and discards remaining work", async () => {
    vi.useFakeTimers();
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test", drainOnClose: true, closeTimeoutMs: 50 });
    let signal: AbortSignal | undefined;
    delivery.enqueue("a", value => new Promise<void>(resolve => {
      signal = value;
      value.addEventListener("abort", () => resolve(), { once: true });
    }), true);
    const queued = vi.fn(async () => undefined);
    delivery.enqueue("a", queued, true);
    await settle();
    const close = delivery.close();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    await close;
    expect(signal?.aborted).toBe(true);
    expect(queued).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("serializes one Conversation while allowing different Conversations to progress", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
    });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    delivery.enqueue("a", async () => {
      calls.push("a:first:start");
      await firstGate;
      calls.push("a:first:end");
    }, true);
    delivery.enqueue("a", async () => {
      calls.push("a:second");
    }, true);
    delivery.enqueue("b", async () => {
      calls.push("b:first");
    }, true);

    await settle();
    expect(calls).toEqual(["a:first:start", "b:first"]);

    releaseFirst();
    await delivery.close();
    expect(calls).toEqual([
      "a:first:start",
      "b:first",
      "a:first:end",
      "a:second",
    ]);
  });

  it("allows a critical operation to replace queued non-critical output", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
      capacity: 1,
    });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    delivery.enqueue("a", async () => {
      calls.push("first");
      await firstGate;
    }, true);
    await settle();
    expect(delivery.enqueue("a", async () => {
      calls.push("non-critical");
    }, false)).toBe(true);
    expect(delivery.enqueue("a", async () => {
      calls.push("critical");
    }, true)).toBe(true);

    releaseFirst();
    await delivery.close();
    expect(calls).toEqual(["first", "critical"]);
  });

  it("rejects excess critical work explicitly so durable callers retain unresolved records", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
      capacity: 1,
    });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    delivery.enqueue("a", async () => {
      calls.push("first");
      await firstGate;
    }, true);
    await settle();
    expect(delivery.enqueue("a", async () => {
      calls.push("second");
    }, true)).toBe(true);
    expect(delivery.enqueue("a", async () => {
      calls.push("third");
    }, true)).toBe(false);

    releaseFirst();
    await delivery.close();
    expect(calls).toEqual(["first", "second"]);
  });

  it("aborts the Conversation worker when closing", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test" });
    let signal!: AbortSignal;
    const started = new Promise<void>((resolve) => {
      delivery.enqueue("a", async (workerSignal) => {
        signal = workerSignal;
        resolve();
      }, true);
    });
    await started;
    await delivery.close();
    expect(signal.aborted).toBe(true);
  });

  it("prioritizes an ordered interaction ahead of queued non-critical output", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
    });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    delivery.enqueue("a", async () => {
      calls.push("first");
      await firstGate;
    }, true);
    await settle();
    delivery.enqueue("a", async () => {
      calls.push("non-critical");
    }, false);
    const interaction = delivery.runOrdered("a", async () => {
      calls.push("interaction");
    });

    releaseFirst();
    await interaction;
    await delivery.close();
    expect(calls).toEqual(["first", "interaction", "non-critical"]);
  });

  it("keeps existing critical output ahead of a prioritized interaction", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
    });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    delivery.enqueue("a", async () => {
      calls.push("first");
      await firstGate;
    }, true);
    await settle();
    delivery.enqueue("a", async () => {
      calls.push("non-critical");
    }, false);
    delivery.enqueue("a", async () => {
      calls.push("critical");
    }, true);
    const interaction = delivery.runOrdered("a", async () => {
      calls.push("interaction");
    });

    releaseFirst();
    await interaction;
    await delivery.close();
    expect(calls).toEqual([
      "first",
      "critical",
      "interaction",
      "non-critical",
    ]);
  });

  it("isolates operation failures and continues the Conversation", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
    });
    const calls: string[] = [];

    delivery.enqueue("a", async () => {
      calls.push("failed");
      throw new Error("expected");
    }, true);
    delivery.enqueue("a", async () => {
      calls.push("continued");
    }, true);

    await delivery.close();
    expect(calls).toEqual(["failed", "continued"]);
  });

  it("returns ordered results and rejects new work after close", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
    });

    await expect(delivery.runOrdered("a", async () => 42)).resolves.toBe(42);
    await delivery.close();

    expect(delivery.enqueue("a", async () => undefined, true)).toBe(false);
    await expect(delivery.runOrdered("a", async () => 1)).rejects.toThrow(
      "输出队列已关闭",
    );
  });

  it("makes concurrent close callers wait for the same in-flight delivery", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    delivery.enqueue("a", () => gate, true);
    await settle();

    const firstClose = delivery.close();
    const secondClose = delivery.close();
    let secondSettled = false;
    void secondClose.then(() => {
      secondSettled = true;
    });
    await settle();

    expect(secondSettled).toBe(false);
    release();
    await Promise.all([firstClose, secondClose]);
  });

  it("releases an idle Conversation worker and accepts later work", async () => {
    const delivery = new ConversationDeliveryQueue(logger, {
      component: "Test",
    });
    const calls: string[] = [];

    await delivery.runOrdered("a", async () => {
      calls.push("first");
    });
    await settle();
    expect(activeWorkerCount(delivery)).toBe(0);
    await delivery.runOrdered("a", async () => {
      calls.push("second");
    });
    await settle();

    expect(activeWorkerCount(delivery)).toBe(0);
    await delivery.close();
    expect(calls).toEqual(["first", "second"]);
  });
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function activeWorkerCount(delivery: ConversationDeliveryQueue): number {
  return (
    delivery as unknown as {
      workers: ReadonlyMap<string, unknown>;
    }
  ).workers.size;
}

it("waits for admitted error replies even when the input handler throws", async () => {
  const queue = new ConversationDeliveryQueue(logger, { component: "Test" });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const failure = new Error("input failed");
  const tracking = queue.track("chat", () => {
    queue.enqueue("chat", () => gate, true);
    throw failure;
  });
  const observed = tracking.catch(error => { settled = true; expect(error).toBe(failure); });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(settled).toBe(false);
  release(); await observed; await queue.close();
});

it("associates nested output with its own tracking context on an existing worker", async () => {
  const queue = new ConversationDeliveryQueue(logger, { component: "Test" });
  await queue.track("chat", () => { queue.enqueue("chat", async () => {}, true); });
  await expect(queue.track("chat", () => {
    queue.enqueue("chat", async () => {
      queue.enqueue("chat", async () => { throw new Error("nested failed"); }, true);
    }, true);
  })).rejects.toThrow("nested failed");
  await queue.close();
});
