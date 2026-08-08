import { describe, expect, it, vi } from "vitest";

import type { OutputEvent } from "../src/conversation-core/index.js";
import { SubagentCompletionTracker } from "../src/bootstrap/subagent-completion-tracker.js";

const target = {
  surface: "feishu" as const,
  accountId: "default",
  conversationId: "conversation-1",
};

function summary() {
  return {
    threadId: "agent-1",
    modelProvider: "deepseek",
    latestDirectApi: null,
    latestTurn: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      reasoningEffort: null,
      turnId: "agent-turn-1",
      requestCount: 2,
      unsuccessfulRequestCount: 0,
      requestDurationMs: 1_500,
      inputTokens: 1_000,
      cachedInputTokens: 500,
      outputTokens: 100,
      reasoningOutputTokens: 0,
      outputTokensPerSecond: 10,
      outputSpeedSampleCount: 1,
      outputSpeedTimedCount: 1,
      pricingCurrency: "USD",
      pricedRequestCount: 2,
      pricedInputTokens: 1_000,
      pricedOutputTokens: 100,
      totalCostNanos: 1_000_000,
      inputCostNanos: 800_000,
      cachedInputCostNanos: 100_000,
      outputCostNanos: 100_000,
      uncachedInputPricePerMillionNanos: 1_000_000_000,
      cachedInputPricePerMillionNanos: 200_000_000,
      outputPricePerMillionNanos: 1_000_000_000,
      hasMixedPrices: false,
      compact: null,
    },
    threadAggregate: {
      provider: "deepseek",
      turnCount: 1,
      requestCount: 2,
      unsuccessfulRequestCount: 0,
      requestDurationMs: 1_500,
      inputTokens: 1_000,
      cachedInputTokens: 500,
      outputTokens: 100,
      reasoningOutputTokens: 0,
      outputTokensPerSecond: 10,
      outputSpeedSampleCount: 1,
      outputSpeedTimedCount: 1,
      pricingCurrency: "USD",
      pricedRequestCount: 2,
      pricedInputTokens: 1_000,
      pricedOutputTokens: 100,
      totalCostNanos: 1_000_000,
      inputCostNanos: 800_000,
      cachedInputCostNanos: 100_000,
      outputCostNanos: 100_000,
      uncachedInputPricePerMillionNanos: 1_000_000_000,
      cachedInputPricePerMillionNanos: 200_000_000,
      outputPricePerMillionNanos: 1_000_000_000,
      hasMixedPrices: false,
      compact: null,
    },
  };
}

function spawned(): OutputEvent {
  return {
    type: "subagent.spawned",
    target,
    threadId: "parent-1",
    turnId: "turn-1",
    agentThreadId: "agent-1",
    agentPath: "/root/review",
  };
}

function state(status: "running" | "completed" | "errored"): OutputEvent {
  return {
    type: "operation.updated",
    target,
    threadId: "parent-1",
    turnId: "turn-1",
    operation: {
      itemId: "wait-1",
      kind: "subagent",
      action: "wait",
      status: "completed",
      receiverThreadIds: ["agent-1"],
      subagentStates: [{ threadId: "agent-1", status }],
    },
  };
}

describe("SubagentCompletionTracker", () => {
  it("does not infer completion from silence and waits for an official terminal state", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    await vi.advanceTimersByTimeAsync(10_000);
    tracker.handle(state("running"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(publish).not.toHaveBeenCalled();

    tracker.handle(state("completed"));
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "subagent.completed",
      agentThreadId: "agent-1",
      status: "completed",
      metricsStatus: "available",
      pricedRequestCount: 2,
      cachedInputTokens: 500,
      reasoningOutputTokens: 0,
      inputCostNanos: 800_000,
      cachedInputCostNanos: 100_000,
      outputCostNanos: 100_000,
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("maps official abnormal terminal states to a failed completion", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handle(state("errored"));
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "subagent.completed",
      status: "errored",
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("settles after the last metric without treating metrics as a terminal state", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.metricsAvailable("agent-1");
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).not.toHaveBeenCalled();

    tracker.handle(state("completed"));
    await vi.advanceTimersByTimeAsync(15);
    tracker.metricsAvailable("agent-1");
    await vi.advanceTimersByTimeAsync(19);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(publish).toHaveBeenCalledTimes(1);

    tracker.close();
    vi.useRealTimers();
  });

  it("publishes an official terminal state even when no model metrics exist", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handle(state("errored"));
    await vi.advanceTimersByTimeAsync(60);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "subagent.completed",
      status: "errored",
      metricsStatus: "empty",
      requestCount: 0,
      pricedRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCostNanos: null,
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("marks metrics unavailable when the summary cannot be read", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => {
        throw new Error("database busy");
      },
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.metricsAvailable("agent-1");
    tracker.handle(state("completed"));
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "subagent.completed",
      status: "completed",
      metricsStatus: "unavailable",
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("waits for queued metrics to be persisted before reading the summary", async () => {
    vi.useFakeTimers();
    let releaseWrites!: (succeeded: boolean) => void;
    const writesPersisted = new Promise<boolean>((resolve) => {
      releaseWrites = resolve;
    });
    const readSummary = vi.fn(() => summary());
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary,
      waitForMetrics: () => writesPersisted,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.metricsAvailable("agent-1");
    tracker.handle(state("completed"));
    await vi.advanceTimersByTimeAsync(20);
    expect(readSummary).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();

    releaseWrites(true);
    await writesPersisted;
    await vi.advanceTimersByTimeAsync(0);
    expect(readSummary).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    tracker.close();
    vi.useRealTimers();
  });

  it("restarts settlement when a metric arrives while a checkpoint is pending", async () => {
    vi.useFakeTimers();
    let releaseFirstCheckpoint!: (succeeded: boolean) => void;
    const firstCheckpoint = new Promise<boolean>((resolve) => {
      releaseFirstCheckpoint = resolve;
    });
    const waitForMetrics = vi.fn()
      .mockReturnValueOnce(firstCheckpoint)
      .mockResolvedValue(true);
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      waitForMetrics,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.metricsAvailable("agent-1");
    tracker.handle(state("completed"));
    await vi.advanceTimersByTimeAsync(20);
    tracker.metricsAvailable("agent-1");
    releaseFirstCheckpoint(true);
    await firstCheckpoint;
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(waitForMetrics).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(1);
    tracker.close();
    vi.useRealTimers();
  });

  it("marks metrics unavailable when a matching queued write fails", async () => {
    vi.useFakeTimers();
    const readSummary = vi.fn(() => summary());
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary,
      waitForMetrics: async () => false,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.metricsAvailable("agent-1");
    tracker.handle(state("completed"));
    await vi.advanceTimersByTimeAsync(20);

    expect(readSummary).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "subagent.completed",
      metricsStatus: "unavailable",
    }));
    tracker.close();
    vi.useRealTimers();
  });
});
