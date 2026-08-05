import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireRequestMetricsDatabaseLock,
  BufferedModelRequestMetricsWriter,
  modelRequestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelRequestMetricSample,
  type ModelRequestMetricsStore,
} from "../src/observability/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SqliteModelRequestMetricsStore", () => {
  it("recovers an old incomplete metrics database lock", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "{", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const lock = acquireRequestMetricsDatabaseLock(path);
    lock.release();

    expect(existsSync(lockPath)).toBe(false);
  });

  it("keeps a recent incomplete metrics database lock fail-closed", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const lockPath = `${path}.lock`;
    writeFileSync(lockPath, "{", { mode: 0o600 });

    expect(() => acquireRequestMetricsDatabaseLock(path)).toThrow(/正在使用/u);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("persists complete sanitized request metrics in a private standalone database", () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, "gateway.sqlite3");
    const path = modelRequestMetricsDatabasePath(statePath);
    const store = new SqliteModelRequestMetricsStore(path);

    store.record(sample());

    expect(path).toBe(join(directory, "request-metrics.sqlite3"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.count()).toBe(1);
    expect(store.recent(1)[0]).toMatchObject({
      ...sample(),
      requestDurationMs: 650,
      totalCostNanos: null,
    });
    store.close();
    const inspection = new DatabaseSync(path, { readOnly: true });
    const columns = inspection.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    inspection.close();
    expect(columns.map((column) => column.name).filter((name) =>
      /body|content|prompt|message|image|authorization/iu.test(name)
    )).toEqual([]);
  });

  it("exposes derived timing, throughput, cache and snapshotted cost metrics", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);
    store.record({
      ...sample(),
      pricing: {
        billingMode: "api",
        currency: "USD",
        source: "test-catalog",
        effectiveAtMs: 1_700_000_000_000,
        uncachedInputPricePerMillionNanos: 2_000_000_000,
        cachedInputPricePerMillionNanos: 1_000_000_000,
        outputPricePerMillionNanos: 3_000_000_000,
      },
    });
    expect(store.threadSummary("thread-1")).toMatchObject({
      latestTurn: {
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        totalCostNanos: 1_400_000,
        uncachedInputPricePerMillionNanos: 2_000_000_000,
        cachedInputPricePerMillionNanos: 1_000_000_000,
        outputPricePerMillionNanos: 3_000_000_000,
        hasMixedPrices: false,
      },
      threadAggregate: {
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        totalCostNanos: 1_400_000,
      },
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      pricingCurrency: "USD",
      pricedRequestCount: 1,
      totalCostNanos: 1_400_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
      hasMixedPrices: false,
    });
    store.close();

    const inspection = new DatabaseSync(path, { readOnly: true });
    const derived = inspection.prepare(`
      SELECT * FROM model_request_metrics_enriched ORDER BY id DESC LIMIT 1
    `).get() as Record<string, unknown>;
    inspection.close();

    expect(derived).toMatchObject({
      billing_mode: "api",
      pricing_currency: "USD",
      pricing_source: "test-catalog",
      request_duration_ms: 650,
      ttft_ms: 100,
      thinking_duration_ms: 200,
      output_duration_ms: 200,
      generation_duration_ms: 500,
      completion_gap_ms: 50,
      upstream_duration_ms: 1_000,
      uncached_input_tokens: 100,
      non_reasoning_output_tokens: 60,
      cache_hit_rate: 0.9,
      thinking_tokens_per_second: 200,
      output_tokens_per_second: 300,
      generation_tokens_per_second: 200,
      uncached_input_cost_nanos: 200_000,
      cached_input_cost_nanos: 900_000,
      output_cost_nanos: 300_000,
      total_cost_nanos: 1_400_000,
    });
  });

  it("does not report one unit price for aggregates containing multiple rates", () => {
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
      pricing: {
        ...pricing,
        effectiveAtMs: 1_700_000_001_000,
        cachedInputPricePerMillionNanos: null,
      },
      cachedInputTokens: 0,
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_650,
    });

    expect(store.threadSummary("thread-1").latestTurn).toMatchObject({
      pricedRequestCount: 2,
      pricingCurrency: "USD",
      hasMixedPrices: true,
      uncachedInputPricePerMillionNanos: null,
      cachedInputPricePerMillionNanos: null,
      outputPricePerMillionNanos: null,
    });
    store.close();
  });

  it("summarizes the latest Turn and latest direct API request for one Thread", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record(sample());
    store.record({
      ...sample(),
      inputTokens: 2_000,
      cachedInputTokens: 1_600,
      outputTokens: 200,
      reasoningOutputTokens: 50,
      totalTokens: 2_200,
      requestStartedAtMs: 2_000,
      firstTokenAtMs: 2_100,
      firstReasoningDeltaAtMs: 2_100,
      lastReasoningDeltaAtMs: 2_200,
      firstOutputDeltaAtMs: 2_300,
      lastOutputDeltaAtMs: 2_600,
      responseCompletedAtMs: 2_700,
    });
    store.record({
      ...sample(),
      provider: "bltcy",
      turnId: null,
      model: "gpt-5.6-luna",
      responseFormat: "json",
      inputTokens: 10_000,
      cachedInputTokens: 0,
      outputTokens: 300,
      reasoningOutputTokens: 50,
      totalTokens: 10_300,
      firstTokenAtMs: null,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: null,
      lastOutputDeltaAtMs: null,
      requestStartedAtMs: 3_000,
      responseCompletedAtMs: 4_000,
    });
    store.record({
      ...sample(),
      provider: "openai",
      transport: "websocket",
      responseFormat: "websocket",
      turnId: null,
      model: "gpt-5.6-sol",
      httpStatus: null,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 1_000,
      requestStartedAtMs: 5_000,
      responseCompletedAtMs: 5_500,
    });

    expect(store.threadSummary("thread-1")).toMatchObject({
      threadId: "thread-1",
      latestTurn: {
        turnId: "turn-1",
        requestCount: 2,
        unsuccessfulRequestCount: 0,
        requestDurationMs: 1_350,
        inputTokens: 3_000,
        cachedInputTokens: 2_500,
        outputTokens: 300,
        reasoningOutputTokens: 90,
        outputSpeedSampleCount: 2,
        outputSpeedTimedCount: 2,
      },
      threadAggregate: {
        turnCount: 1,
        requestCount: 2,
        unsuccessfulRequestCount: 0,
        inputTokens: 3_000,
        cachedInputTokens: 2_500,
        outputTokens: 300,
        reasoningOutputTokens: 90,
        outputSpeedSampleCount: 2,
        outputSpeedTimedCount: 2,
      },
      latestDirectApi: {
        provider: "bltcy",
        model: "gpt-5.6-luna",
        requestDurationMs: 1_000,
        totalTokens: 10_300,
      },
    });
    expect(store.threadSummary("thread-1").latestTurn?.outputTokensPerSecond)
      .toBeCloseTo(210 / 0.5);
    store.close();
  });

  it("excludes requests without a matching output window from aggregate speed", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record(sample());
    store.record({
      ...sample(),
      outputTokens: 200,
      reasoningOutputTokens: 50,
      firstOutputDeltaAtMs: null,
      lastOutputDeltaAtMs: null,
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_500,
    });

    const summary = store.threadSummary("thread-1");
    expect(summary.latestTurn).toMatchObject({
      outputSpeedSampleCount: 2,
      outputSpeedTimedCount: 1,
    });
    expect(summary.latestTurn?.outputTokensPerSecond).toBeCloseTo(60 / 0.2);
    expect(summary.threadAggregate).toMatchObject({
      turnCount: 1,
      outputSpeedSampleCount: 2,
      outputSpeedTimedCount: 1,
    });
    expect(summary.threadAggregate?.outputTokensPerSecond).toBeCloseTo(60 / 0.2);
    store.close();
  });

  it("separates the latest Turn aggregate from the whole Thread aggregate", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record(sample());
    store.record({
      ...sample(),
      turnId: "turn-2",
      requestStartedAtMs: 2_000,
      firstTokenAtMs: 2_100,
      firstReasoningDeltaAtMs: 2_100,
      lastReasoningDeltaAtMs: 2_300,
      firstOutputDeltaAtMs: 2_400,
      lastOutputDeltaAtMs: 2_600,
      responseCompletedAtMs: 2_650,
    });

    const summary = store.threadSummary("thread-1");
    expect(summary.latestTurn).toMatchObject({ turnId: "turn-2", requestCount: 1 });
    expect(summary.threadAggregate).toMatchObject({ turnCount: 2, requestCount: 2 });
    store.close();
  });

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
        provider: "openai",
        model: "gpt-5.6-sol",
        status: "failed",
        httpStatus: null,
        errorType: "websocket_closed",
        requestCount: 2,
        lastOccurredAtMs: now.getTime() - 60 * 60 * 1_000,
      },
      {
        provider: "bltcy",
        model: "gpt-5.6-luna",
        status: "incomplete",
        httpStatus: 429,
        errorType: "rate_limit_error",
        requestCount: 1,
        lastOccurredAtMs: now.getTime() - 60 * 60 * 1_000,
      },
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

  it("rejects priced snapshots without a currency", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);

    expect(() => store.record({
      ...sample(),
      pricing: {
        billingMode: "api",
        currency: null,
        source: "test-catalog",
        effectiveAtMs: 1_700_000_000_000,
        uncachedInputPricePerMillionNanos: 2_000_000_000,
        cachedInputPricePerMillionNanos: null,
        outputPricePerMillionNanos: null,
      },
    })).toThrow(/constraint/iu);

    store.close();
  });

  it("removes records older than thirty days when reopened", () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const initialTime = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(initialTime);
    const first = new SqliteModelRequestMetricsStore(path);
    first.record(sample());
    first.close();

    vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
    const reopened = new SqliteModelRequestMetricsStore(path);

    expect(reopened.count()).toBe(0);
    reopened.close();
  });

  it("fails closed when the standalone metrics schema version is unsupported", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_metadata (name, value) VALUES ('schema_version', 99);
    `);
    database.close();

    expect(() => new SqliteModelRequestMetricsStore(path)).toThrow(
      /codexc metrics reset/u,
    );
  });

  it("rolls back an interrupted first schema initialization", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TRIGGER reject_schema_version
      BEFORE INSERT ON schema_metadata
      BEGIN
        SELECT RAISE(ABORT, 'schema version rejected');
      END;
    `);
    database.close();

    expect(() => new SqliteModelRequestMetricsStore(path)).toThrow(
      /schema version rejected/u,
    );

    const inspection = new DatabaseSync(path, { readOnly: true });
    const modelTable = inspection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'model_request_metrics'
    `).get();
    inspection.close();
    expect(modelTable).toBeUndefined();
  });

  it("bounds internal reads independently from future presentation APIs", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );

    expect(() => store.recent(0)).toThrow(/1 到 500/u);
    expect(() => store.recent(501)).toThrow(/1 到 500/u);
    store.close();
  });

  it("opens the live database read-only and pages sanitized records", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const writer = new SqliteModelRequestMetricsStore(path);
    writer.record(sample());
    writer.record({
      ...sample(),
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_650,
    });

    const reader = new SqliteModelRequestMetricsStore(path, Date.now(), {
      readOnly: true,
    });
    const first = reader.page({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
      limit: 1,
    });
    expect(first.records).toHaveLength(1);
    expect(first.nextAfterId).toBe(first.records[0]?.id);
    const second = reader.page({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
      ...(first.nextAfterId === null ? {} : { afterId: first.nextAfterId }),
      limit: 1,
    });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.id).not.toBe(first.records[0]?.id);
    expect(second.nextAfterId).toBeNull();
    expect(() => reader.record(sample())).toThrow(/只读/u);
    reader.close();
    writer.close();
  });
});

describe("BufferedModelRequestMetricsWriter", () => {
  it("writes at most one synchronous SQLite record per scheduled turn", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const writer = new BufferedModelRequestMetricsWriter({
      record,
      recent: () => [],
      aggregate: () => emptyMetricsReport(),
      errors: () => emptyErrorReport(),
      count: () => 0,
      close: () => undefined,
    });
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
    const record = vi.fn<ModelRequestMetricsStore["record"]>(() => {
      calls.push("record");
    });
    const writer = new BufferedModelRequestMetricsWriter({
      record,
      recent: () => [],
      aggregate: () => emptyMetricsReport(),
      errors: () => emptyErrorReport(),
      count: () => 0,
      close: () => {
        calls.push("close");
      },
    });
    writer.enqueue(sample());

    expect(record).not.toHaveBeenCalled();
    await writer.close();

    expect(record).toHaveBeenCalledWith(sample());
    expect(calls).toEqual(["record", "close"]);
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-"));
  temporaryDirectories.push(directory);
  return directory;
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
  };
}
