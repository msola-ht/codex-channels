import { describe, expect, it, vi } from "vitest";

import type {
  ConversationInputEvent,
  OutputEvent,
} from "../src/conversation-core/index.js";
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
      reasoningEffort: "medium",
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

function spawned(
  agentThreadId = "agent-1",
  agentPath = "/root/review",
): Extract<OutputEvent, { type: "subagent.spawned" }> {
  return {
    type: "subagent.spawned",
    target,
    threadId: "parent-1",
    turnId: "turn-1",
    agentThreadId,
    agentPath,
  };
}

function contacted(): Extract<OutputEvent, { type: "subagent.contacted" }> {
  return {
    type: "subagent.contacted",
    target,
    threadId: "parent-1",
    turnId: "turn-2",
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

function waitCompleted(
  parentThreadId = "parent-1",
  parentTurnId = "turn-1",
): OutputEvent {
  return {
    type: "operation.updated",
    target,
    threadId: parentThreadId,
    turnId: parentTurnId,
    operation: {
      itemId: "wait-v2",
      kind: "subagent",
      action: "wait",
      status: "completed",
      receiverThreadIds: [],
      subagentStates: [],
    },
  };
}

function completedActivity(
  parentTurnId = "turn-1",
  agentThreadId = "agent-1",
): Extract<ConversationInputEvent, { type: "item.subagentActivity" }> {
  return {
    type: "item.subagentActivity",
    threadId: "parent-1",
    turnId: parentTurnId,
    itemId: `completed-${agentThreadId}-${parentTurnId}`,
    agentThreadId,
    agentPath: "/root/review",
    kind: "completed",
  };
}

describe("SubagentCompletionTracker", () => {
  it("reports unresolved runs for the parent Thread until every child reaches a terminal state", () => {
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish: vi.fn(),
      settleDelayMs: 20,
    });

    tracker.handle(spawned("agent-1", "/root/first"));
    tracker.handle(spawned("agent-2", "/root/second"));
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(true);

    tracker.handleInput({
      ...completedActivity("turn-1", "agent-1"),
      agentPath: "/root/first",
    });
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(true);

    tracker.handleInput({
      ...completedActivity("turn-1", "agent-2"),
      agentPath: "/root/second",
    });
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);
    tracker.close();
  });

  it("raises the parent release barrier before the asynchronous spawn output is consumed", () => {
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish: vi.fn(),
      settleDelayMs: 20,
    });

    tracker.handleInput({
      ...completedActivity(),
      itemId: "started-agent-1-turn-1",
      kind: "started",
    });
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(true);

    tracker.handle(spawned());
    tracker.handleInput(completedActivity());
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);
    tracker.close();
  });

  it("does not treat an interaction as a new run before a child Turn starts", () => {
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish: vi.fn(),
      settleDelayMs: 20,
    });

    tracker.handleInput({
      ...completedActivity("turn-2"),
      itemId: "interacted-agent-1-turn-2",
      kind: "interacted",
    });
    tracker.handle(contacted());
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);

    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-2",
    });
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(true);
    tracker.close();
  });

  it("distinguishes a follow-up Turn from a queue-only agent message", () => {
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish: vi.fn(),
      settleDelayMs: 20,
    });
    const operation = (
      action: "send_message" | "followup_task",
      itemId = `${action}-1`,
    ): ConversationInputEvent => ({
      type: "item.operation.updated",
      threadId: "parent-1",
      turnId: "turn-2",
      operation: {
        itemId,
        kind: "subagent",
        action,
        status: "completed",
        receiverThreadIds: ["agent-1"],
      },
    });

    tracker.handleInput(operation("send_message"));
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);

    tracker.handleInput(operation("followup_task"));
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(true);
    tracker.handleInput(completedActivity("turn-2"));
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);
    tracker.handleInput(operation("followup_task"));
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);

    tracker.handleInput(operation("followup_task", "followup_task-2"));
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(true);
    tracker.handleInput({
      ...completedActivity("turn-2"),
      itemId: "completed-agent-1-turn-2-second-run",
    });
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);
    tracker.close();
  });

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
    expect(publish).not.toHaveBeenCalled();

    tracker.handleInput(completedActivity());
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "subagent.completed",
      agentThreadId: "agent-1",
      status: "completed",
      metricsStatus: "available",
      pricedRequestCount: 2,
      cachedInputTokens: 500,
      reasoningOutputTokens: 0,
      reasoningEffort: "medium",
      outputTokensPerSecond: 10,
      outputSpeedSampleCount: 1,
      outputSpeedTimedCount: 1,
      inputCostNanos: 800_000,
      cachedInputCostNanos: 100_000,
      outputCostNanos: 100_000,
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("settles successful runs from the parent-attributed completion activity", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    await vi.advanceTimersByTimeAsync(12_345);
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).not.toHaveBeenCalled();

    tracker.handleInput(completedActivity());
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      type: "subagent.completed",
      agentThreadId: "agent-1",
      status: "completed",
      elapsedMs: 12_365,
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("retains an early parent-attributed completion until the spawn activity is registered", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handleInput(completedActivity());
    tracker.handle(spawned());
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      agentThreadId: "agent-1",
      status: "completed",
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("rejects a successful completion attributed to a different parent run", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput(completedActivity("turn-2"));
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).not.toHaveBeenCalled();

    tracker.handleInput(completedActivity());
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      agentThreadId: "agent-1",
      status: "completed",
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it.each([
    ["interrupted", "interrupted"],
    ["failed", "errored"],
  ] as const)("maps a child %s turn to %s", async (turnStatus, expectedStatus) => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: turnStatus,
      error: turnStatus === "failed" ? "failed" : null,
    });
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      status: expectedStatus,
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("accepts the official interrupted activity as a terminal signal", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "item.subagentActivity",
      threadId: "parent-1",
      turnId: "turn-1",
      itemId: "interrupt-1",
      agentThreadId: "agent-1",
      agentPath: "/root/review",
      kind: "interrupted",
    });
    expect(tracker.hasPendingForParentThread("parent-1")).toBe(false);
    await vi.advanceTimersByTimeAsync(20);

    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      status: "interrupted",
    }));
    tracker.close();
    vi.useRealTimers();
  });

  it("tracks a new completion after contacting an already settled subagent", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "interrupted",
      error: null,
    });
    await vi.advanceTimersByTimeAsync(20);

    tracker.handle(contacted());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity("turn-2"));
    await vi.advanceTimersByTimeAsync(20);

    expect(publish.mock.calls.map(([event]) => event.status)).toEqual([
      "interrupted",
      "completed",
    ]);
    tracker.close();
    vi.useRealTimers();
  });

  it("preserves both completions when a subagent is contacted during settlement", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "interrupted",
      error: null,
    });
    tracker.handle(contacted());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity("turn-2"));
    await vi.advanceTimersByTimeAsync(20);

    expect(publish.mock.calls.map(([event]) => event.status)).toEqual([
      "interrupted",
      "completed",
    ]);
    tracker.close();
    vi.useRealTimers();
  });

  it("attributes repeated subagent completions to their exact child Turns", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const readSummary = vi.fn((_threadId: string, turnId?: string) => {
      const value = summary();
      const requestCount = turnId === "agent-turn-1" ? 1 : 2;
      return {
        latestTurn: value.latestTurn,
        threadAggregate: {
          ...value.threadAggregate,
          requestCount,
        },
      };
    });
    const onRunStarted = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary,
      publish,
      onRunStarted,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-1",
    });
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity());
    tracker.handle(contacted());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-2",
    });
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity("turn-2"));
    await vi.advanceTimersByTimeAsync(20);

    expect(readSummary.mock.calls).toEqual([
      ["agent-1", "agent-turn-1"],
      ["agent-1", "agent-turn-2"],
    ]);
    expect(onRunStarted.mock.calls).toEqual([
      [{
        agentThreadId: "agent-1",
        agentTurnId: "agent-turn-1",
        parentThreadId: "parent-1",
        parentTurnId: "turn-1",
        agentPath: "/root/review",
      }],
      [{
        agentThreadId: "agent-1",
        agentTurnId: "agent-turn-2",
        parentThreadId: "parent-1",
        parentTurnId: "turn-2",
        agentPath: "/root/review",
      }],
    ]);
    expect(publish.mock.calls.map(([event]) => event.requestCount)).toEqual([1, 2]);
    tracker.close();
    vi.useRealTimers();
  });

  it("uses the active child Turn for the parent-attributed completion", async () => {
    vi.useFakeTimers();
    const readSummary = vi.fn(() => summary());
    const tracker = new SubagentCompletionTracker({
      readSummary,
      publish: vi.fn(),
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-1",
    });
    tracker.handleInput(completedActivity());
    await vi.advanceTimersByTimeAsync(20);

    expect(readSummary).toHaveBeenCalledWith("agent-1", "agent-turn-1");
    tracker.close();
    vi.useRealTimers();
  });

  it("does not apply a delayed metric from the previous child Turn to a follow-up", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      waitForMetrics: async () => true,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-1",
    });
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity());
    tracker.handle(contacted());
    await vi.advanceTimersByTimeAsync(0);

    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-2",
    });
    tracker.metricsAvailable("agent-1", "agent-turn-1");
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity("turn-2"));
    tracker.handle(waitCompleted("parent-1", "turn-2"));
    await vi.advanceTimersByTimeAsync(0);

    expect(publish).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(2);
    tracker.close();
    vi.useRealTimers();
  });

  it("pairs a follow-up child Turn that starts before its interacted activity", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const onRunStarted = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: (_threadId, turnId) => {
        const value = summary();
        return {
          latestTurn: value.latestTurn,
          threadAggregate: {
            ...value.threadAggregate,
            requestCount: turnId === "agent-turn-1" ? 1 : 2,
          },
        };
      },
      onRunStarted,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-1",
    });
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-2",
    });
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity());
    tracker.handle(contacted());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity("turn-2"));
    await vi.advanceTimersByTimeAsync(20);

    expect(onRunStarted.mock.calls.map(([details]) => details.agentTurnId)).toEqual([
      "agent-turn-1",
      "agent-turn-2",
    ]);
    expect(publish.mock.calls.map(([event]) => event.requestCount)).toEqual([1, 2]);
    tracker.close();
    vi.useRealTimers();
  });

  it("ignores a stale completion from the previous child Turn", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-1",
    });
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity());
    tracker.handle(contacted());
    await vi.advanceTimersByTimeAsync(0);
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-2",
    });
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(1);

    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity("turn-2"));
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(2);
    tracker.close();
    vi.useRealTimers();
  });

  it("retains an interacted activity until the previous child Turn completes", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const onRunStarted = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      onRunStarted,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-1",
    });
    tracker.handle(contacted());
    tracker.handleInput({
      type: "turn.started",
      threadId: "agent-1",
      turnId: "agent-turn-2",
    });
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity("turn-2"));
    await vi.advanceTimersByTimeAsync(20);

    expect(onRunStarted.mock.calls.map(([details]) => details.agentTurnId)).toEqual([
      "agent-turn-1",
      "agent-turn-2",
    ]);
    expect(publish).toHaveBeenCalledTimes(2);
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

  it("accelerates settlement when the first metric arrives after the terminal state", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handleInput(completedActivity());
    tracker.handle(waitCompleted());
    await vi.advanceTimersByTimeAsync(15);
    expect(publish).not.toHaveBeenCalled();

    tracker.metricsAvailable("agent-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(1);

    tracker.close();
    vi.useRealTimers();
  });

  it("publishes immediately after an observed metric is persisted", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      waitForMetrics: async () => true,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.metricsAvailable("agent-1");
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity());
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();

    tracker.handle(waitCompleted());
    await vi.advanceTimersByTimeAsync(0);

    expect(publish).toHaveBeenCalledTimes(1);
    tracker.close();
    vi.useRealTimers();
  });

  it("ignores an unrelated parent wait and falls back within the bounded delay", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      waitForMetrics: async () => true,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.metricsAvailable("agent-1");
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-1",
      turnId: "agent-turn-1",
      status: "completed",
      error: null,
    });
    tracker.handleInput(completedActivity());
    tracker.handle(waitCompleted("unrelated-parent"));
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(1);
    tracker.close();
    vi.useRealTimers();
  });

  it("does not reuse an earlier parent wait for a later parallel completion", async () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const tracker = new SubagentCompletionTracker({
      readSummary: () => summary(),
      waitForMetrics: async () => true,
      publish,
      settleDelayMs: 20,
    });

    tracker.handle(spawned());
    tracker.handle(spawned("agent-2", "/root/parallel"));
    tracker.metricsAvailable("agent-2");
    tracker.handle(waitCompleted());
    tracker.handleInput({
      type: "turn.completed",
      threadId: "agent-2",
      turnId: "agent-turn-2",
      status: "completed",
      error: null,
    });
    tracker.handleInput({
      ...completedActivity("turn-1", "agent-2"),
      agentPath: "/root/parallel",
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      agentThreadId: "agent-2",
      status: "completed",
    }));
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
    tracker.handleInput(completedActivity());
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
    tracker.handleInput(completedActivity());
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
    tracker.handleInput(completedActivity());
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
    tracker.handleInput(completedActivity());
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
