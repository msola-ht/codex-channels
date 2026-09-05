import { describe, expect, it, vi } from "vitest";

import {
  RequestMetricsQueryAdapter,
  resolveRequestMetricsRange,
} from "../src/bootstrap/request-metrics-query-adapter.js";
import type { SqliteModelRequestMetricsStore } from "../src/observability/index.js";

describe("RequestMetricsQueryAdapter", () => {
  it("exposes a direct local Turn count without loading the full summary", () => {
    const threadTurnCount = vi.fn(() => 4);
    const store = { threadTurnCount } as unknown as SqliteModelRequestMetricsStore;
    const adapter = new RequestMetricsQueryAdapter(
      store,
      { modelSettingsForThread: () => undefined } as never,
      [],
    );

    expect(adapter.threadTurnCount("thread-1")).toBe(4);
    expect(threadTurnCount).toHaveBeenCalledWith("thread-1");
  });

  it("maps provider labels without leaking Store pricing rows", () => {
    const aggregate = vi.fn(() => ({
      startAtMs: 1,
      endAtMs: 2,
      aggregate: null,
      groups: [{ provider: "custom", model: "model-1", aggregate: null }],
      totalGroupCount: 1,
    }));
    const errors = vi.fn(() => ({
      startAtMs: 1,
      endAtMs: 2,
      requestCount: 1,
      unsuccessfulRequestCount: 1,
      groups: [{
        provider: "custom",
        model: "model-1",
        status: "failed",
        httpStatus: 500,
        errorType: "upstream",
        lastErrorMessage: "failed",
        requestCount: 1,
        lastOccurredAtMs: 2,
      }],
      totalGroupCount: 1,
    }));
    const store = {
      threadSummary: () => ({
        threadId: "thread-1",
        latestTurn: null,
        threadAggregate: null,
        latestDirectApi: {
          provider: "custom",
          model: "model-1",
          status: "completed",
          httpStatus: 200,
          requestDurationMs: 10,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 2,
          reasoningOutputTokens: 0,
          totalTokens: 3,
          pricing: null,
          totalCostNanos: null,
          uncachedInputCostNanos: null,
          cachedInputCostNanos: null,
          outputCostNanos: null,
        },
      }),
      aggregate,
      errors,
      weeklyQuotaEstimate: vi.fn(() => null),
    } as unknown as SqliteModelRequestMetricsStore;
    const adapter = new RequestMetricsQueryAdapter(
      store,
      { modelSettingsForThread: () => ({ modelProvider: "custom" }) } as never,
      [{ id: "custom", name: "Custom API" }],
      () => 2,
    );

    expect(adapter.forThread("thread-1")).toMatchObject({
      modelProvider: "custom",
      latestDirectApi: {
        provider: "custom",
        providerName: "Custom API",
        pricingCurrency: null,
      },
    });
    expect(adapter.aggregate("providers", "all").groups[0]).toMatchObject({
      provider: "custom",
      providerName: "Custom API",
    });
    expect(adapter.errors("all").groups[0]).toMatchObject({
      provider: "custom",
      providerName: "Custom API",
    });
    expect(aggregate).toHaveBeenCalledWith({
      dimension: "provider",
      startAtMs: 0,
      endAtMs: 2,
    });
    expect(errors).toHaveBeenCalledWith({ startAtMs: 0, endAtMs: 2 });
  });

  it("resolves bounded and calendar ranges from one captured time", () => {
    const now = new Date(2026, 7, 24, 10, 30).getTime();
    expect(resolveRequestMetricsRange("24h", now)).toEqual({
      startAtMs: now - 24 * 60 * 60 * 1_000,
      endAtMs: now,
    });
    const today = new Date(2026, 7, 24).getTime();
    expect(resolveRequestMetricsRange("today", now)).toEqual({
      startAtMs: today,
      endAtMs: now,
    });
  });
});
