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
});

describe("BufferedModelRequestMetricsWriter", () => {
  it("writes at most one synchronous SQLite record per scheduled turn", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const writer = new BufferedModelRequestMetricsWriter({
      record,
      recent: () => [],
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
