import pino from "pino";
import { describe, expect, it } from "vitest";

import { ConversationDeliveryQueue } from "../src/surfaces/index.js";

const logger = pino({ level: "silent" });

describe("ConversationDeliveryQueue", () => {
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
