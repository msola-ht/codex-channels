import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ProviderMetricsComposition,
  toModelTimingEvent,
} from "../src/bootstrap/provider-metrics-composition.js";
import {
  BufferedModelRequestMetricsWriter,
  type ModelRequestMetricsStore,
} from "../src/observability/index.js";
import {
  sendProviderProxyMetrics,
  type ProviderProxyMetrics,
} from "../src/provider-proxy/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("ProviderMetricsComposition", () => {
  it("composes the proxy channel, durable store and existing Core timing port", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-composition-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "deepseek.sock");
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const close = vi.fn<ModelRequestMetricsStore["close"]>();
    const timings: unknown[] = [];
    const composition = new ProviderMetricsComposition({
      providers: ["deepseek"],
      socketPath: () => socketPath,
      writer: new BufferedModelRequestMetricsWriter({
        record,
        close,
        count: () => 0,
        recent: () => [],
        aggregate: () => emptyMetricsReport(),
        errors: () => emptyErrorReport(),
      }),
      onModelTiming: (event) => timings.push(event),
      logger: pino({ level: "silent" }),
    });
    await composition.start();

    await sendProviderProxyMetrics(socketPath, metrics());

    expect(record).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith({
        provider: "deepseek",
        ...metrics(),
        pricing: null,
        reasoningEffort: null,
      });
    });
    expect(timings).toEqual([expect.objectContaining({
      type: "turn.modelTiming.updated",
      threadId: "thread-1",
      turnId: "turn-1",
      outcome: "completed",
      ttftMs: 200,
      thinkingDurationMs: 300,
      outputDurationMs: 200,
      generationDurationMs: 600,
    })]);
    await composition.close();
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("persists unassociated requests without fabricating Core timing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-unassociated-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "openai.sock");
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const onModelTiming = vi.fn();
    const composition = new ProviderMetricsComposition({
      providers: ["openai"],
      socketPath: () => socketPath,
      writer: new BufferedModelRequestMetricsWriter({
        record,
        close: () => undefined,
        count: () => 0,
        recent: () => [],
        aggregate: () => emptyMetricsReport(),
        errors: () => emptyErrorReport(),
      }),
      onModelTiming,
      logger: pino({ level: "silent" }),
    });
    await composition.start();
    const unassociated = { ...metrics(), threadId: null, turnId: null };

    await sendProviderProxyMetrics(socketPath, unassociated);

    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith({
        provider: "openai",
        ...unassociated,
        pricing: null,
        reasoningEffort: null,
      });
    });
    expect(onModelTiming).not.toHaveBeenCalled();
    await composition.close();
  });

  it("attaches an injected pricing snapshot without coupling the proxy to prices", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-pricing-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "deepseek.sock");
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const pricing = {
      billingMode: "api" as const,
      currency: "USD",
      source: "future-setup",
      effectiveAtMs: 1_700_000_000_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };
    const resolve = vi.fn(() => pricing);
    const onModelTiming = vi.fn();
    const composition = new ProviderMetricsComposition({
      providers: ["deepseek"],
      socketPath: () => socketPath,
      writer: new BufferedModelRequestMetricsWriter({
        record,
        close: () => undefined,
        count: () => 0,
        recent: () => [],
        aggregate: () => emptyMetricsReport(),
        errors: () => emptyErrorReport(),
      }),
      pricingResolver: { resolve },
      onModelTiming,
      logger: pino({ level: "silent" }),
    });
    await composition.start();

    await sendProviderProxyMetrics(socketPath, metrics());

    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith({
        provider: "deepseek",
        ...metrics(),
        pricing,
        reasoningEffort: null,
      });
    });
    expect(resolve).toHaveBeenCalledWith({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      inputTokens: 100,
      atMs: 1_900,
    });
    expect(onModelTiming).toHaveBeenCalledWith(expect.objectContaining({
      pricingCurrency: "USD",
      totalCostNanos: 180_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    }));
    await composition.close();
  });

  it("keeps failed request usage without adding it to reference cost", () => {
    const pricing = {
      billingMode: "api" as const,
      currency: "USD",
      source: "test-catalog",
      effectiveAtMs: 1_700_000_000_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };

    const event = toModelTimingEvent({
      ...metrics(),
      status: "failed",
      httpStatus: 503,
      errorType: "http_error",
    }, pricing);

    expect(event).toMatchObject({
      outcome: "failed",
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
    });
    expect(event).not.toHaveProperty("pricingCurrency");
    expect(event).not.toHaveProperty("totalCostNanos");
  });

  it("includes compact usage and reference cost in the bound Turn", () => {
    const pricing = {
      billingMode: "api" as const,
      currency: "USD",
      source: "test-catalog",
      effectiveAtMs: 1_700_000_000_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };

    expect(toModelTimingEvent({
      ...metrics(),
      operation: "compact",
    }, pricing)).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      inputTokens: 100,
      cachedInputTokens: 80,
      outputTokens: 20,
      pricingCurrency: "USD",
      totalCostNanos: 180_000,
    });
  });

  it("carries the bound Thread reasoning effort into recorded metrics", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-effort-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "deepseek.sock");
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const composition = new ProviderMetricsComposition({
      providers: ["deepseek"],
      socketPath: () => socketPath,
      writer: new BufferedModelRequestMetricsWriter({
        record,
        close: () => undefined,
        count: () => 0,
        recent: () => [],
        aggregate: () => emptyMetricsReport(),
        errors: () => emptyErrorReport(),
      }),
      resolveModelSettings: (threadId) => threadId === "thread-1"
        ? {
            model: "deepseek-v4-flash",
            modelProvider: "deepseek",
            effort: "max",
            serviceTier: "default",
            collaborationMode: "default",
          }
        : undefined,
      onModelTiming: vi.fn(),
      logger: pino({ level: "silent" }),
    });
    await composition.start();

    await sendProviderProxyMetrics(socketPath, metrics());

    await vi.waitFor(() => {
      expect(record).toHaveBeenCalledWith(expect.objectContaining({
        provider: "deepseek",
        reasoningEffort: "max",
      }));
    });
    await composition.close();
  });

  it("marks an upstream 503 as a retryable model failure", async () => {
    const failed = {
      ...metrics(),
      model: null,
      status: "failed" as const,
      httpStatus: 503,
      errorType: "http_error",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      firstTokenAtMs: null,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: null,
      lastOutputDeltaAtMs: null,
    };

    expect(toModelTimingEvent(failed)).toMatchObject({
      outcome: "failed",
      retryableFailure: true,
    });
    expect(toModelTimingEvent({ ...failed, httpStatus: 400 })).not.toHaveProperty(
      "retryableFailure",
    );
  });

  it("marks an upstream WebSocket close as retryable but keeps a client disconnect interrupted", async () => {
    const failed = {
      ...metrics(),
      model: null,
      status: "failed" as const,
      httpStatus: null,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      firstTokenAtMs: null,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: null,
      lastOutputDeltaAtMs: null,
    };

    expect(toModelTimingEvent({
      ...failed,
      responseFormat: "websocket",
      errorType: "websocket_closed",
    })).toMatchObject({
      outcome: "failed",
      retryableFailure: true,
    });
    expect(toModelTimingEvent({
      ...failed,
      responseFormat: "websocket",
      errorType: "client_disconnected",
    })).toMatchObject({
      outcome: "interrupted",
    });
    expect(toModelTimingEvent({
      ...failed,
      responseFormat: "websocket",
      errorType: "client_disconnected",
    })).not.toHaveProperty("retryableFailure");
  });
});

function metrics(): ProviderProxyMetrics {
  return {
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-1",
    turnId: "turn-1",
    model: "deepseek-v4-flash",
    serviceTier: "default",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    incompleteReason: null,
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    upstreamCreatedAt: 1_785_640_800,
    upstreamCompletedAt: 1_785_640_801,
    requestStartedAtMs: 1_000,
    firstTokenAtMs: 1_200,
    firstReasoningDeltaAtMs: 1_200,
    lastReasoningDeltaAtMs: 1_500,
    firstOutputDeltaAtMs: 1_600,
    lastOutputDeltaAtMs: 1_800,
    responseCompletedAtMs: 1_900,
    weeklyQuota: null,
  };
}

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
