import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics aggregate reports", () => {
  it("aggregates all request sources uniformly by provider and model within a time range", () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
      now.getTime(),
    );
    vi.setSystemTime(new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000));
    store.record({ ...sample(), provider: "old", model: "old-model" });
    vi.setSystemTime(now);
    store.record(sample());
    store.record({
      ...sample(),
      provider: "deepseek",
      turnId: null,
      model: "deepseek-v4-flash",
      status: "failed",
      firstTokenAtMs: 1_300,
      firstReasoningDeltaAtMs: 1_300,
      lastReasoningDeltaAtMs: 1_400,
      firstOutputDeltaAtMs: 1_500,
      lastOutputDeltaAtMs: 1_700,
      responseCompletedAtMs: 1_750,
    });
    store.record({
      ...sample(),
      provider: "openai",
      model: "gpt-5.6-sol",
      firstTokenAtMs: 1_900,
      firstReasoningDeltaAtMs: 1_900,
      lastReasoningDeltaAtMs: 2_000,
      firstOutputDeltaAtMs: 2_100,
      lastOutputDeltaAtMs: 2_300,
      responseCompletedAtMs: 2_350,
    });

    const range = {
      startAtMs: now.getTime() - 7 * 24 * 60 * 60 * 1_000,
      endAtMs: now.getTime() + 1,
    };
    const global = store.aggregate({ dimension: "global", ...range });
    expect(global.aggregate).toMatchObject({
      requestCount: 3,
      unsuccessfulRequestCount: 1,
      inputTokens: 3_000,
      cachedInputTokens: 2_700,
      outputTokens: 300,
      reasoningOutputTokens: 120,
      outputSpeedSampleCount: 3,
      outputSpeedTimedCount: 3,
      ttftP50Ms: 300,
      ttftP95Ms: 900,
      ttftSampleCount: 3,
    });
    expect(global.aggregate?.ttftAverageMs).toBeCloseTo(433.333, 2);

    const providers = store.aggregate({ dimension: "provider", ...range });
    expect(providers.totalGroupCount).toBe(2);
    expect(providers.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "deepseek",
        model: null,
        aggregate: expect.objectContaining({ requestCount: 2 }),
      }),
      expect.objectContaining({
        provider: "openai",
        model: null,
        aggregate: expect.objectContaining({ requestCount: 1 }),
      }),
    ]));

    const models = store.aggregate({ dimension: "model", ...range });
    expect(models.totalGroupCount).toBe(2);
    expect(models.groups).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "deepseek", model: "deepseek-v4-flash" }),
      expect.objectContaining({ provider: "openai", model: "gpt-5.6-sol" }),
    ]));
    store.close();
  });

  it("rejects invalid aggregation ranges", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    expect(() => store.aggregate({
      dimension: "global",
      startAtMs: 2,
      endAtMs: 1,
    })).toThrow(/时间范围无效/u);
    store.close();
  });

  it("summarizes unsuccessful requests by provider, model and error", () => {
    vi.useFakeTimers();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
      now.getTime(),
    );
    vi.setSystemTime(new Date(now.getTime() - 8 * 24 * 60 * 60 * 1_000));
    store.record({
      ...sample(),
      provider: "openai",
      model: "gpt-5.6-sol",
      status: "failed",
      errorType: "old_error",
    });
    vi.setSystemTime(new Date(now.getTime() - 2 * 60 * 60 * 1_000));
    store.record(sample());
    store.record({
      ...sample(),
      provider: "openai",
      model: "gpt-5.6-sol",
      status: "failed",
      httpStatus: null,
      errorType: "websocket_closed",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
    vi.setSystemTime(new Date(now.getTime() - 60 * 60 * 1_000));
    store.record({
      ...sample(),
      provider: "openai",
      model: "gpt-5.6-sol",
      status: "failed",
      httpStatus: null,
      errorType: "websocket_closed",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
    vi.setSystemTime(new Date(now.getTime() - 30 * 60 * 1_000));
    store.record({
      ...sample(),
      provider: "bltcy",
      model: "gpt-5.6-luna",
      status: "incomplete",
      httpStatus: 429,
      errorType: "rate_limit_error",
    });

    const report = store.errors({
      startAtMs: now.getTime() - 7 * 24 * 60 * 60 * 1_000,
      endAtMs: now.getTime() + 1,
    });
    expect(report).toMatchObject({
      requestCount: 4,
      unsuccessfulRequestCount: 3,
      totalGroupCount: 2,
    });
    expect(report.groups).toEqual([
      {
        provider: "bltcy",
        model: "gpt-5.6-luna",
        status: "incomplete",
        httpStatus: 429,
        errorType: "rate_limit_error",
        lastErrorMessage: null,
        requestCount: 1,
        lastOccurredAtMs: now.getTime() - 30 * 60 * 1_000,
      },
      {
        provider: "openai",
        model: "gpt-5.6-sol",
        status: "failed",
        httpStatus: null,
        errorType: "websocket_closed",
        lastErrorMessage: null,
        requestCount: 2,
        lastOccurredAtMs: now.getTime() - 60 * 60 * 1_000,
      },
    ]);
    const failures = store.page({
      startAtMs: now.getTime() - 7 * 24 * 60 * 60 * 1_000,
      endAtMs: now.getTime() + 1,
      limit: 10,
      onlyFailures: true,
    });
    expect(failures.matchedTotal).toBe(3);
    expect(failures.records.map((record) => record.status)).toEqual([
      "incomplete",
      "failed",
      "failed",
    ]);
    store.close();
  });

  it("normalizes historical unobservable HTTP successes as incomplete", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({
      ...sample(),
      responseFormat: "unknown",
      model: null,
      serviceTier: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });

    expect(store.recent(1)[0]).toMatchObject({
      status: "incomplete",
      incompleteReason: "response_not_observed",
    });
    expect(store.threadSummary("thread-1").latestTurn).toMatchObject({
      requestCount: 1,
      unsuccessfulRequestCount: 1,
      pricedRequestCount: 0,
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      requestCount: 1,
      unsuccessfulRequestCount: 1,
      pricedRequestCount: 0,
    });
    expect(store.errors({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    })).toMatchObject({
      requestCount: 1,
      unsuccessfulRequestCount: 1,
      groups: [{
        provider: "deepseek",
        model: null,
        status: "incomplete",
        httpStatus: 200,
        errorType: "response_not_observed",
        requestCount: 1,
      }],
    });
    store.close();
  });

  it("keeps a historical completed record with only total tokens observable", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({
      ...sample(),
      responseFormat: "unknown",
      model: null,
      serviceTier: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: 120,
    });

    expect(store.recent(1)[0]).toMatchObject({
      status: "completed",
      incompleteReason: null,
      totalTokens: 120,
    });
    expect(store.threadSummary("thread-1").latestTurn).toMatchObject({
      requestCount: 1,
      unsuccessfulRequestCount: 0,
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      requestCount: 1,
      unsuccessfulRequestCount: 0,
    });
    expect(store.errors({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    })).toMatchObject({
      requestCount: 1,
      unsuccessfulRequestCount: 0,
      groups: [],
    });
    store.close();
  });

  it("keeps successful compact operations completed without model usage", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({
      ...sample(),
      operation: "compact",
      responseFormat: "unknown",
      model: null,
      serviceTier: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });

    expect(store.recent(1)[0]).toMatchObject({
      operation: "compact",
      status: "completed",
      incompleteReason: null,
    });
    store.close();
  });

  it("includes compact usage and cost in request summaries", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    const pricing = {
      billingMode: "api" as const,
      currency: "USD",
      source: "test-catalog",
      effectiveAtMs: 1_700_000_000_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };
    store.record({ ...sample(), pricing });
    store.record({
      ...sample(),
      operation: "compact",
      pricing,
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_650,
    });

    expect(store.threadSummary("thread-1")).toMatchObject({
      latestTurn: {
        requestCount: 2,
        inputTokens: 2_000,
        outputTokens: 200,
        pricedRequestCount: 2,
        totalCostNanos: 2_800_000,
        compact: {
          model: "deepseek-v4-flash",
          hasMixedModels: false,
          requestCount: 1,
          unsuccessfulRequestCount: 0,
          inputTokens: 1_000,
          cachedInputTokens: 900,
          outputTokens: 100,
          pricingCurrency: "USD",
          pricedRequestCount: 1,
          totalCostNanos: 1_400_000,
        },
      },
      threadAggregate: {
        requestCount: 2,
        inputTokens: 2_000,
        outputTokens: 200,
        pricedRequestCount: 2,
        totalCostNanos: 2_800_000,
        compact: {
          model: "deepseek-v4-flash",
          hasMixedModels: false,
          requestCount: 1,
          unsuccessfulRequestCount: 0,
          inputTokens: 1_000,
          cachedInputTokens: 900,
          outputTokens: 100,
          pricingCurrency: "USD",
          pricedRequestCount: 1,
          totalCostNanos: 1_400_000,
        },
      },
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      requestCount: 2,
      inputTokens: 2_000,
      outputTokens: 200,
      pricedRequestCount: 2,
      totalCostNanos: 2_800_000,
      compact: {
        model: "deepseek-v4-flash",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 1_000,
        cachedInputTokens: 900,
        outputTokens: 100,
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        totalCostNanos: 1_400_000,
      },
    });
    expect(store.errors({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    })).toMatchObject({
      requestCount: 2,
      unsuccessfulRequestCount: 0,
    });
    expect(store.threadTurnSummaries("thread-1")[0]).toMatchObject({
      requestCount: 2,
      inputTokens: 2_000,
      outputTokens: 200,
      pricedRequestCount: 2,
      totalCostNanos: 2_800_000,
      compact: {
        model: "deepseek-v4-flash",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 1_000,
        cachedInputTokens: 900,
        outputTokens: 100,
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        totalCostNanos: 1_400_000,
      },
    });
    expect(store.threadList()[0]).toMatchObject({
      requestCount: 2,
      inputTokens: 2_000,
      outputTokens: 200,
      pricedRequestCount: 2,
      totalCostNanos: 2_800_000,
      compact: {
        model: "deepseek-v4-flash",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 1_000,
        cachedInputTokens: 900,
        outputTokens: 100,
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        totalCostNanos: 1_400_000,
      },
    });
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-aggregate-"));
  directories.push(directory);
  return directory;
}
