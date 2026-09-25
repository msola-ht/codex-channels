import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics aggregate reports", () => {
  it("excludes missing cache samples from both sides of cache usage without losing total usage", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "request-metrics.sqlite3"));
    const now = Date.now();
    const scope = { startAtMs: now - 1000, endAtMs: now + 1000, limit: 1 };
    try {
      store.recordBatch([
        { ...sample(), recordedAtMs: now, inputTokens: 100, cachedInputTokens: 80 },
        { ...sample(), recordedAtMs: now, inputTokens: 300, cachedInputTokens: 0 },
        { ...sample(), recordedAtMs: now, inputTokens: 900, cachedInputTokens: null },
        { ...sample(), recordedAtMs: now, inputTokens: null, cachedInputTokens: 20 },
        { ...sample(), recordedAtMs: now, inputTokens: null, cachedInputTokens: null },
        { ...sample(), recordedAtMs: now - 2000, inputTokens: 1000, cachedInputTokens: 1000 },
      ]);
      const expected = { inputTokens: 1300,
        cacheUsage: { inputTokens: 400, cachedInputTokens: 80, missingRequestCount: 3 } };
      expect(store.aggregate({ ...scope, dimension: "global" }).aggregate).toMatchObject(expected);
      expect(store.aggregate({ ...scope, dimension: "provider" }).groups[0]?.aggregate).toMatchObject(expected);
      expect(store.page(scope).aggregate).toMatchObject(expected);
      expect(store.threadList(scope).aggregate).toMatchObject(expected);
      expect(store.threadList(scope).threads[0]).toMatchObject(expected);
      expect(store.threadTurnSummaries("thread-1", scope).aggregate).toMatchObject(expected);
      expect(store.aggregate({ ...scope, dimension: "global", provider: "missing" }).aggregate).toBeNull();
    } finally {
      store.close();
    }
  });

  it.each([
    [null, null, 0, 1],
    [0, 0, 100, 0],
    [50, 50, 100, 0],
  ])("preserves missing and zero cache observations (%s)", (cachedInputTokens, expectedCached, expectedInput, missingRequestCount) => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "request-metrics.sqlite3"));
    const now = Date.now();
    try {
      store.record({ ...sample(), recordedAtMs: now, inputTokens: 100, cachedInputTokens });
      const result = store.threadList({ startAtMs: now - 1000, endAtMs: now + 1000, limit: 10 });
      expect(result.threads[0]?.cacheUsage).toEqual({ cachedInputTokens: expectedCached, inputTokens: expectedInput, missingRequestCount });
    } finally {
      store.close();
    }
  });

  it.each(["Asia/Shanghai", "America/New_York", "Asia/Kathmandu", "UTC"])("groups by system calendar day and hour in %s", (timeZone) => {
    const directory = temporaryDirectory();
    const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { SqliteModelRequestMetricsStore } from './src/observability/index.ts';
      import { resolveRequestMetricsRange, RequestMetricsQueryService } from './src/observability/request-metrics-query-service.ts';
      import { sample } from './tests/request-metrics-fixtures.ts';
      const results = [];
      for (const [month, day] of [[8, 18], [2, 8], [10, 1]]) {
        const start = new Date(2026, month, day).getTime();
        const end = new Date(2026, month, day + 1).getTime();
        const store = new SqliteModelRequestMetricsStore(process.argv[1] + '/' + month + '.sqlite3', end);
        store.recordBatch([start - 1, start, end - 1, end].map(recordedAtMs => ({...sample(), recordedAtMs})));
        const range = resolveRequestMetricsRange('yesterday', end);
        const service = new RequestMetricsQueryService(store);
        const hours = service.trend(range).hourly;
        const today = service.trend(resolveRequestMetricsRange('today', start + 1)).hourly;
        results.push({rows: store.daily(range), hours, today, count: store.aggregate({...range, dimension:'global'}).aggregate.requestCount});
        if (process.env.TZ === 'America/New_York' && month === 10) {
          store.recordBatch(['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'].map(value => ({...sample(), recordedAtMs: Date.parse(value)})));
          const repeated = service.trend(range).hourly[1];
          if (repeated.requestCount !== 2) throw new Error('Repeated local hour lost requests');
        }
        store.close();
      }
      console.log(JSON.stringify(results));
    `, directory], { env: { ...process.env, TZ: timeZone }, encoding: "utf8" });
    const reports = JSON.parse(result) as Array<{
      rows: Array<{ day: string; requestCount: number }>;
      hours: Array<{ hour: string; requestCount: number }>;
      today: Array<{ hour: string; requestCount: number }>;
      count: number;
    }>;
    expect(reports.map((report) => report.rows)).toMatchObject([
      [{ day: "2026-09-18", requestCount: 2 }],
      [{ day: "2026-03-08", requestCount: 2 }],
      [{ day: "2026-11-01", requestCount: 2 }],
    ]);
    expect(reports.map((report) => report.count)).toEqual([2, 2, 2]);
    for (const report of reports) {
      expect(report.hours).toHaveLength(24);
      expect(report.hours[0]).toMatchObject({ hour: `${report.rows[0]!.day} 00:00`, requestCount: 1 });
      expect(report.hours[23]).toMatchObject({ hour: `${report.rows[0]!.day} 23:00`, requestCount: 1 });
      expect(report.hours.reduce((sum, row) => sum + row.requestCount, 0)).toBe(report.count);
      expect(report.today).toEqual([report.hours[0]]);
    }
  });

  it("keeps a read snapshot stable across concurrent writes and releases it after failure", () => {
    const path = join(temporaryDirectory(), "request-metrics.sqlite3");
    const writer = new SqliteModelRequestMetricsStore(path);
    writer.record({ ...sample(), recordedAtMs: 100 });
    const reader = new SqliteModelRequestMetricsStore(path, Date.now(), { readOnly: true });
    const query = { startAtMs: 0, endAtMs: Date.now() + 1, dimension: "global" as const };
    try {
      reader.readSnapshot(() => {
        expect(reader.aggregate(query).aggregate?.requestCount).toBe(1);
        writer.record({ ...sample(), recordedAtMs: 200 });
        expect(reader.daily(query).reduce((sum, row) => sum + row.requestCount, 0)).toBe(1);
      });
      expect(reader.aggregate(query).aggregate?.requestCount).toBe(2);
      expect(() => reader.readSnapshot(() => { throw new Error("snapshot failed"); })).toThrow("snapshot failed");
      expect(reader.readSnapshot(() => reader.aggregate(query).aggregate?.requestCount)).toBe(2);
    } finally {
      reader.close();
      writer.close();
    }
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
      responseCompletedAtMs: 1_750,
    });
    store.record({
      ...sample(),
      provider: "openai",
      model: "gpt-5.6-sol",
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
    });

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
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      requestCount: 1,
      unsuccessfulRequestCount: 1,
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

  it("includes compact usage in request summaries", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record(sample());
    store.record({
      ...sample(),
      operation: "compact",
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_650,
    });

    expect(store.threadSummary("thread-1")).toMatchObject({
      latestTurn: {
        requestCount: 2,
        inputTokens: 2_000,
        outputTokens: 200,
        compact: {
          model: "deepseek-v4-flash",
          hasMixedModels: false,
          requestCount: 1,
          unsuccessfulRequestCount: 0,
          inputTokens: 1_000,
          cachedInputTokens: 900,
          outputTokens: 100,
        },
      },
      threadAggregate: {
        requestCount: 2,
        inputTokens: 2_000,
        outputTokens: 200,
        compact: {
          model: "deepseek-v4-flash",
          hasMixedModels: false,
          requestCount: 1,
          unsuccessfulRequestCount: 0,
          inputTokens: 1_000,
          cachedInputTokens: 900,
          outputTokens: 100,
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
      compact: {
        model: "deepseek-v4-flash",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 1_000,
        cachedInputTokens: 900,
        outputTokens: 100,
      },
    });
    expect(store.errors({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    })).toMatchObject({
      requestCount: 2,
      unsuccessfulRequestCount: 0,
    });
    expect(store.threadTurnSummaries("thread-1", { startAtMs: 0, endAtMs: Date.now() + 1, limit: 500 }).turns[0]).toMatchObject({
      requestCount: 2,
      inputTokens: 2_000,
      outputTokens: 200,
      compact: {
        model: "deepseek-v4-flash",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 1_000,
        cachedInputTokens: 900,
        outputTokens: 100,
      },
    });
    expect(store.threadList({ startAtMs: 0, endAtMs: Date.now() + 1, limit: 500 }).threads[0]).toMatchObject({
      requestCount: 2,
      inputTokens: 2_000,
      outputTokens: 200,
      compact: {
        model: "deepseek-v4-flash",
        hasMixedModels: false,
        requestCount: 1,
        unsuccessfulRequestCount: 0,
        inputTokens: 1_000,
        cachedInputTokens: 900,
        outputTokens: 100,
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
