import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import { ConversationDeliveryQueue } from "../src/surfaces/index.js";

const logger = pino({ level: "silent" });

describe("ConversationDeliveryQueue", () => {
  it("releases cancelled queued owners immediately but retains in-flight owners until actual settlement", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test", maximumPendingOperations: 2 });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const active = new AbortController();
    const queued = new AbortController();
    const settledActive = vi.fn();
    const settledQueued = vi.fn();
    const skipped = vi.fn(async () => {});
    try {
      delivery.enqueue("chat", async () => { await blocked; }, true, { signal: active.signal, settled: settledActive });
      await settle();
      delivery.enqueue("chat", skipped, true, { signal: queued.signal, settled: settledQueued });
      queued.abort();
      expect(settledQueued).toHaveBeenCalledOnce();
      active.abort();
      expect(settledActive).not.toHaveBeenCalled();
      expect(delivery.enqueue("chat", async () => {}, true)).toBe(true);
      release();
      await delivery.waitForIdle();
      expect(settledActive).toHaveBeenCalledOnce();
      expect(settledQueued).toHaveBeenCalledOnce();
      expect(skipped).not.toHaveBeenCalled();
    } finally { release(); await delivery.close(); }
  });

  it("bounds recovery drain waits without closing the queue", async () => {
    vi.useFakeTimers();
    try {
      const delivery = new ConversationDeliveryQueue(logger, { component: "Test", closeTimeoutMs: 10 });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      const calls: string[] = [];
      delivery.enqueue("chat", async () => { await blocked; calls.push("old"); }, true);
      delivery.enqueue("chat", async () => { calls.push("queued"); }, true);
      const waiting = delivery.waitForIdle();
      await vi.advanceTimersByTimeAsync(10);
      expect(await waiting).toBe(false);
      release();
      expect(await delivery.waitForIdle()).toBe(true);
      expect(delivery.enqueue("chat", async () => { calls.push("new"); }, true)).toBe(true);
      expect(await delivery.waitForIdle()).toBe(true);
      expect(calls).toEqual(["old", "queued", "new"]);
      await delivery.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains ordinary output but immediately cancels ordered interactions on close", async () => {
    vi.useFakeTimers();
    try {
      const delivery = new ConversationDeliveryQueue(logger, { component: "Test", drainOnClose: true, closeTimeoutMs: 10 });
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => { release = resolve; });
      let normalSignal: AbortSignal | undefined;
      let orderedSignal: AbortSignal | undefined;
      delivery.enqueue("normal", async (signal) => { normalSignal = signal; await blocked; }, true);
      const ordered = delivery.runOrdered("interaction", async (signal) => { orderedSignal = signal; await blocked; });
      const rejected = expect(ordered).rejects.toThrow("已取消");
      await vi.advanceTimersByTimeAsync(0);
      const closing = delivery.close();
      await rejected;
      expect(orderedSignal?.aborted).toBe(true);
      expect(normalSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      await closing;
      expect(normalSignal?.aborted).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(0);
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

  it("retains critical operations when the bounded queue is full of critical work", async () => {
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
    }, true)).toBe(true);

    releaseFirst();
    await delivery.close();
    expect(calls).toEqual(["first", "second", "third"]);
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

  it("coalesces pending same-key output per Conversation while keeping other keys", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test" });
    const calls: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    delivery.enqueue("a", async () => {
      calls.push("in-flight");
      await firstGate;
    }, true);
    await settle();
    delivery.enqueue("a", async () => {
      calls.push("reasoning-1");
    }, true, { coalesceKey: "reasoning:thread:turn" });
    delivery.enqueue("a", async () => {
      calls.push("reasoning-2");
    }, true, { coalesceKey: "reasoning:thread:turn" });
    delivery.enqueue("a", async () => {
      calls.push("approval");
    }, true);

    releaseFirst();
    await delivery.close();
    expect(calls).toEqual(["in-flight", "reasoning-2", "approval"]);
  });

  it("keeps coalesce keys scoped to a single Conversation", async () => {
    const delivery = new ConversationDeliveryQueue(logger, { component: "Test" });
    const calls: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    delivery.enqueue("a", async () => {
      calls.push("a:in-flight");
      await gateA;
    }, true);
    delivery.enqueue("b", async () => {
      calls.push("b:in-flight");
      await gateB;
    }, true);
    await settle();
    delivery.enqueue("a", async () => {
      calls.push("a:reasoning-1");
    }, true, { coalesceKey: "reasoning:thread:turn" });
    delivery.enqueue("a", async () => {
      calls.push("a:reasoning-2");
    }, true, { coalesceKey: "reasoning:thread:turn" });
    delivery.enqueue("b", async () => {
      calls.push("b:reasoning");
    }, true, { coalesceKey: "reasoning:thread:turn" });

    releaseA();
    releaseB();
    await delivery.close();
    expect([...calls].sort()).toEqual([
      "a:in-flight",
      "a:reasoning-2",
      "b:in-flight",
      "b:reasoning",
    ]);
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


it("replaces a waiting key even at the shared hard limit without admitting another conversation", async () => {
  const delivery = new ConversationDeliveryQueue(logger, { component: "Test", maximumPendingOperations: 2 });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  delivery.enqueue("a", () => blocked, true);
  await settle();
  try {
    expect(delivery.enqueue("a", async () => { calls.push("old"); }, true, { coalesceKey: "state" })).toBe(true);
    expect(delivery.enqueue("a", async () => { calls.push("latest"); }, true, { coalesceKey: "state" })).toBe(true);
    expect(delivery.enqueue("b", async () => { calls.push("overflow"); }, true, { coalesceKey: "state" })).toBe(false);
    release();
    await delivery.close();
    expect(calls).toEqual(["latest"]);
  } finally { release(); await delivery.close(); }
});
