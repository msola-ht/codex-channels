import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BufferedModelRequestMetricsWriter,
  type ModelRequestMetricSample,
  type ModelRequestMetricsStore,
} from "../src/observability/index.js";

afterEach(() => {
  vi.useRealTimers();
});

function emptyMetricsReport() {
  return {
    dimension: "global" as const,
    startAtMs: 0,
    endAtMs: 1,
    aggregate: null,
    groups: [],
    totalGroupCount: 0,
  };
}

function emptyErrorReport() {
  return {
    startAtMs: 0,
    endAtMs: 1,
    requestCount: 0,
    unsuccessfulRequestCount: 0,
    groups: [],
    totalGroupCount: 0,
  };
}

function sample(): ModelRequestMetricSample {
  return {
    provider: "deepseek",
    pricing: null,
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-1",
    turnId: "turn-1",
    model: "deepseek-v4-flash",
    serviceTier: "default",
    reasoningEffort: "max",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 1_100,
    upstreamCreatedAt: 1_785_640_800,
    upstreamCompletedAt: 1_785_640_801,
    requestStartedAtMs: 1_000,
    firstTokenAtMs: 1_100,
    firstReasoningDeltaAtMs: 1_100,
    lastReasoningDeltaAtMs: 1_300,
    firstOutputDeltaAtMs: 1_400,
    lastOutputDeltaAtMs: 1_600,
    responseCompletedAtMs: 1_650,
    weeklyQuota: null,
    quotaWindows: null,
  };
}

function createWriter(record: ModelRequestMetricsStore["record"], close: () => void = () => undefined) {
  return new BufferedModelRequestMetricsWriter({
    record,
    recordSubagentThread: () => undefined,
    recordSubagentTurn: () => undefined,
    requestRowsAfter: () => [],
    subagentThreadsAfter: () => [],
    recent: () => [],
    aggregate: () => emptyMetricsReport(),
    threadTurnTaskSummary: () => null,
    errors: () => emptyErrorReport(),
    count: () => 0,
    close,
  });
}

describe("BufferedModelRequestMetricsWriter", () => {
  it("writes at most one synchronous SQLite record per scheduled turn", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const writer = createWriter(record);
    writer.enqueue(sample());
    writer.enqueue(sample());
    writer.enqueue(sample());

    await vi.advanceTimersByTimeAsync(10);
    expect(record).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(record).toHaveBeenCalledTimes(2);

    await writer.close();
    expect(record).toHaveBeenCalledTimes(3);
  });

  it("drains pending metrics before closing the independent store", async () => {
    const calls: string[] = [];
    const record = vi.fn<ModelRequestMetricsStore["record"]>(() => calls.push("record"));
    const writer = createWriter(record, () => calls.push("close"));
    writer.enqueue(sample());

    expect(record).not.toHaveBeenCalled();
    await writer.close();

    expect(record).toHaveBeenCalledWith(sample());
    expect(calls).toEqual(["record", "close"]);
  });

  it("resolves a persistence checkpoint after the writes already enqueued", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const writer = createWriter(record);
    writer.enqueue(sample());
    writer.enqueue(sample());
    writer.enqueue(sample());
    let checkpointResolved = false;
    const persistenceCheckpoint = writer.waitForCurrentWrites();
    const checkpoint = persistenceCheckpoint.then(() => {
      checkpointResolved = true;
    });
    writer.enqueue(sample());

    await vi.advanceTimersByTimeAsync(20);
    expect(checkpointResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    await expect(persistenceCheckpoint).resolves.toBe(true);
    await checkpoint;
    expect(checkpointResolved).toBe(true);
    expect(record).toHaveBeenCalledTimes(3);
    await writer.close();
    expect(record).toHaveBeenCalledTimes(4);
  });

  it("reports a failed write through the matching thread checkpoint", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>(() => {
      throw new Error("disk full");
    });
    const writer = createWriter(record);
    writer.enqueue(sample());

    const checkpoint = writer.waitForCurrentWrites("thread-1");
    await vi.advanceTimersByTimeAsync(10);

    await expect(checkpoint).resolves.toBe(false);
    await writer.close();
  });

  it("does not fail a thread checkpoint for another thread's write", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>((metric) => {
      if (metric.threadId === "thread-2") throw new Error("disk full");
    });
    const writer = createWriter(record);
    writer.enqueue({ ...sample(), threadId: "thread-2" });
    writer.enqueue(sample());

    const checkpoint = writer.waitForCurrentWrites("thread-1");
    await vi.advanceTimersByTimeAsync(20);

    await expect(checkpoint).resolves.toBe(true);
    await writer.close();
  });

  it("does not fail a Turn checkpoint for another Turn in the same Thread", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>((metric) => {
      if (metric.turnId === "turn-2") throw new Error("disk full");
    });
    const writer = createWriter(record);
    writer.enqueue({ ...sample(), turnId: "turn-2" });
    writer.enqueue(sample());

    const checkpoint = writer.waitForCurrentWrites("thread-1", "turn-1");
    await vi.advanceTimersByTimeAsync(20);

    await expect(checkpoint).resolves.toBe(true);
    await writer.close();
  });
});
