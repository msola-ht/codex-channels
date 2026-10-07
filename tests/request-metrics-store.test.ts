import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  modelRequestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  parseRequestMetricsFilters,
} from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("SqliteModelRequestMetricsStore", () => {
  it("persists review purpose and distinct identities without a dump, retaining unknown rows and exact filtering after reopen", () => {
    const path = join(temporaryDirectory(), "metrics.sqlite3");
    let store = new SqliteModelRequestMetricsStore(path);
    const identities = { requestPurpose: "autoApprovalReview" as const,
      reviewerThreadId: "reviewer", reviewerTurnId: "review-turn" };
    const scope = { startAtMs: 0, endAtMs: Date.now() + 1000, limit: 10 };
    try {
      store.record({ ...sample(), ...identities });
      store.record({ ...sample(), ...identities, threadId: null, turnId: null, reviewerTurnId: null });
      store.record(sample());
      store.close();
      store = new SqliteModelRequestMetricsStore(path, Date.now(), { readOnly: true });
      expect(store.count()).toBe(3);
      const rows = store.requestRowsAfter(0, 10);
      expect(rows[0]).toMatchObject({ ...identities, threadId: "thread-1", turnId: "turn-1", traffic: null });
      expect(rows[1]).toMatchObject({ ...identities, threadId: null, turnId: null, reviewerTurnId: null, traffic: null });
      expect(rows[2]).toMatchObject({ requestPurpose: null, reviewerThreadId: null, reviewerTurnId: null });
      const filters = parseRequestMetricsFilters({ requestPurpose: "autoApprovalReview" });
      expect(store.page({ ...scope, ...filters }).matchedTotal).toBe(2);
      expect(store.page({ ...scope, ...filters, threadId: "thread-1", turnId: "turn-1" }).matchedTotal).toBe(1);
      expect(store.page(scope).matchedTotal).toBe(3);
      for (const value of [null, "ordinary", "guardian", "", 1]) {
        expect(() => parseRequestMetricsFilters({ requestPurpose: value })).toThrow(/requestPurpose/u);
        expect(() => store.page({ ...scope, requestPurpose: value } as never)).toThrow(/requestPurpose/u);
      }
    } finally { store.close(); }
  });
  it("rejects unsupported or unsafe reviewer facts instead of storing inferred identity", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const review = { ...sample(), requestPurpose: "autoApprovalReview" as const,
      reviewerThreadId: "reviewer", reviewerTurnId: "review-turn" };
    try {
      for (const invalid of [{ requestPurpose: null }, { requestPurpose: "guardian" },
        { reviewerThreadId: "\t" }, { reviewerTurnId: "x".repeat(129) }, { turnId: null }]) {
        expect(() => store.record({ ...review, ...invalid } as never)).toThrow(/自动审查/u);
      }
      expect(store.count()).toBe(0);
    } finally { store.close(); }
  });
  it("uses full request durations for burst-delivered output in turn and session rates", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    try {
      for (const [outputTokens, totalDurationMs, interval] of [[31, 3188.22, 3.620824], [19, 3495.05, 36.138991]] as const) {
        store.record({ ...sample(), outputTokens, totalDurationMs, responseTimeMs: 350,
          generationTiming: { reasoningMs: 0, textMs: 0, toolMs: interval, totalMs: interval } });
      }
      expect(store.threadTurnSummary("thread-1", "turn-1")?.performance?.generationTokensPerSecond).toBeCloseTo(7.481, 3);
      expect(store.threadSummary("thread-1").threadAggregate?.performance?.generationTokensPerSecond).toBeCloseTo(7.481, 3);
    } finally { store.close(); }
  });
  it("keeps performance unknown when no valid samples exist", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    try {
      store.record({ ...sample(), firstTokenMs: null, outputTokens: null });
      const expected = { requestCount: 1, firstTokenSampleCount: 0, averageFirstTokenMs: null, generationTokensPerSecond: null };
      expect(store.threadTurnSummary("thread-1", "turn-1")?.performance).toEqual(expected);
      expect(store.threadSummary("thread-1").threadAggregate?.performance).toEqual(expected);
    } finally { store.close(); }
  });
  it("aggregates session performance across turns and descendants without compaction or unrelated threads", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    try {
      const request = { ...sample(), firstTokenMs: 100, responseTimeMs: 10, outputTokens: 100, totalDurationMs: 1000,
        generationTiming: { reasoningMs: 0, textMs: 1000, toolMs: 0, totalMs: 1000 } };
      store.record(request);
      store.record({ ...request, turnId: "turn-2", firstTokenMs: 300, outputTokens: 300 });
      store.recordSubagentThread({ agentThreadId: "child", parentThreadId: "thread-1", parentTurnId: "turn-1", agentPath: "/root/child" });
      store.record({ ...request, threadId: "child", firstTokenMs: 500, outputTokens: 500 });
      store.record({ ...sample(), operation: "compact" });
      store.record({ ...sample(), threadId: "unrelated" });
      expect(store.threadSummary("thread-1").threadAggregate?.performance).toEqual({
        requestCount: 3, firstTokenSampleCount: 3, averageFirstTokenMs: 300, generationTokensPerSecond: 300,
      });
      store.record({ ...sample(), turnId: "old-turn", outputTokens: null });
      expect(store.threadSummary("thread-1").threadAggregate?.performance).toEqual({
        requestCount: 4, firstTokenSampleCount: 3, averageFirstTokenMs: 300, generationTokensPerSecond: 300,
      });
    } finally { store.close(); }
  });
  it.each([
    { outputTokens: 0 },
    { outputTokens: null },
    { totalDurationMs: 0 },
    { status: "failed" as const },
    { status: "incomplete" as const },
  ])("excludes unusable requests from both speed numerator and denominator: %j", (override) => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    try {
      const request = { ...sample(), firstTokenMs: 0, outputTokens: 100, totalDurationMs: 1000 };
      store.record(request);
      store.record({ ...request, outputTokens: 900, ...override });
      expect(store.threadTurnSummary("thread-1", "turn-1")?.performance).toEqual({
        requestCount: 2, firstTokenSampleCount: 2, averageFirstTokenMs: 0, generationTokensPerSecond: 100,
      });
      expect(store.threadSummary("thread-1")?.latestTurn?.performance?.generationTokensPerSecond).toBe(100);
    } finally { store.close(); }
  });
  it("rebuilds weighted turn performance from persisted requests and excludes other scopes", () => {
    const path = join(temporaryDirectory(), "metrics.sqlite3");
    let store = new SqliteModelRequestMetricsStore(path);
    try {
      store.record({ ...sample(), firstTokenMs: 100, responseTimeMs: 10, outputTokens: 100, totalDurationMs: 1000,
        generationTiming: { reasoningMs: 0, textMs: 1000, toolMs: 0, totalMs: 1000 } });
      store.record({ ...sample(), firstTokenMs: 300, responseTimeMs: 20, outputTokens: 900, totalDurationMs: 3000,
        generationTiming: { reasoningMs: 2000, textMs: 0, toolMs: 1000, totalMs: 3000 } });
      store.record({ ...sample(), operation: "compact" });
      store.record({ ...sample(), threadId: "child" });
      store.record({ ...sample(), turnId: "other" });
      store.close(); store = new SqliteModelRequestMetricsStore(path);
      expect(store.threadTurnSummary("thread-1", "turn-1")?.performance).toEqual({
        requestCount: 2, firstTokenSampleCount: 2, averageFirstTokenMs: 200, generationTokensPerSecond: 250,
      });
      store.record({ ...sample(), outputTokens: null });
      expect(store.threadTurnSummary("thread-1", "turn-1")?.performance).toEqual({
        requestCount: 3, firstTokenSampleCount: 2, averageFirstTokenMs: 200, generationTokensPerSecond: 250,
      });
    } finally { store.close(); }
  });
  it("persists request diagnostic facts without traffic and rejects unsafe diagnostic values", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const facts = { upstreamProvider: "deepseek", upstreamAttemptCount: 3, modelAttemptCount: 2, finishReason: "stop",
      errorStage: "stream" as const, upstreamErrorCode: "rate_limit_exceeded", upstreamErrorType: "rate_limit_error", upstreamHttpStatus: 429 };
    try {
      store.record({ ...sample(), ...facts }); store.record(sample());
      expect(store.requestRowsAfter(0, 10)[0]).toMatchObject({ ...facts, traffic: null });
      expect(store.requestRowsAfter(0, 10)[1]).toMatchObject(Object.fromEntries(Object.keys(facts).map(key => [key, null])));
      expect(store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, limit: 10 }).records[1]).toMatchObject(facts);
      for (const invalid of [{ upstreamProvider: "unsafe value" }, { upstreamErrorCode: "x".repeat(257) },
        { upstreamAttemptCount: -1 }, { modelAttemptCount: 1.5 }, { upstreamHttpStatus: 200 }]) {
        expect(() => store.record({ ...sample(), ...invalid })).toThrow();
      }
      expect(store.count()).toBe(2);
    } finally { store.close(); }
  });
  it("persists exact response amounts and distinguishes missing usage from zero in request queries", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    try {
      for (const responseUsageAmount of [undefined, null, "0", "0.12345678901234567890"]) {
        store.record({ ...sample(), ...(responseUsageAmount === undefined ? {} : { responseUsageAmount }) });
      }
      const values = store.requestRowsAfter(0, 10).map(row => row.responseUsageAmount);
      expect(values).toEqual([null, null, "0", "0.12345678901234567890"]);
      expect(store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, limit: 10 }).records.map(row => row.responseUsageAmount)).toEqual([...values].reverse());
      expect(() => store.record({ ...sample(), responseUsageAmount: "secret" })).toThrow("用量");
      expect(store.count()).toBe(4);
    } finally { store.close(); }
  });
  it("keeps quota queries in the caller's read snapshot and rejects them after close", () => {
    const now = Date.now();
    const path = join(temporaryDirectory(), "metrics.sqlite3");
    const resetsAt = Math.floor(now / 1_000) + 3_600;
    const writer = new SqliteModelRequestMetricsStore(path, now);
    const record = (used: number, offset: number) => writer.record({
      ...sample(), provider: "openai", recordedAtMs: now + offset,
      weeklyQuota: { limitId: "codex", resetsAt, usedPercentMillionths: used * 1_000_000, planType: "plus" },
    });
    record(10, 0);
    const reader = new SqliteModelRequestMetricsStore(path, now, { readOnly: true });
    const range = { startAtMs: now, endAtMs: now + 100 };
    const estimate = { provider: "openai", limitId: "codex" as const, resetsAt, nowMs: now + 100 };
    try {
      reader.readSnapshot(() => {
        expect(reader.quotaHistory(range)[0]?.requestCount).toBe(1);
        record(20, 1);
        expect(reader.latestWeeklyQuota("openai", now + 100)?.usedPercentMillionths).toBe(10_000_000);
        expect(reader.weeklyQuotaEstimate(estimate)).toBeNull();
      });
      expect(reader.quotaHistory(range)[0]?.requestCount).toBe(2);
      expect(reader.weeklyQuotaEstimate(estimate)?.observedDeltaPercentMillionths).toBe(10_000_000);
    } finally {
      reader.close();
      writer.close();
    }
    expect(() => reader.quotaHistory(range)).toThrow("模型请求指标数据库已关闭");
    expect(() => reader.weeklyQuotaEstimate(estimate)).toThrow("模型请求指标数据库已关闭");
    expect(() => reader.latestWeeklyQuota("openai", now)).toThrow("模型请求指标数据库已关闭");
  });

  it("retains streaming statements through GC and releases iterators after visitor failure", () => {
    const directory = temporaryDirectory();
    execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { StatementSync } from 'node:sqlite';
      import { SqliteModelRequestMetricsStore } from './src/observability/index.ts';
      import { sample } from './tests/request-metrics-fixtures.ts';
      const originalIterate = StatementSync.prototype.iterate;
      StatementSync.prototype.iterate = function (...args) {
        const iterator = originalIterate.apply(this, args);
        return (function* () {
          global.gc();
          yield* iterator;
        })();
      };
      const now = Date.now();
      const resetsAt = Math.floor(now / 1000) + 3600;
      const store = new SqliteModelRequestMetricsStore(process.argv[1]);
      try {
        store.recordBatch([10, 20].map((used, index) => ({ ...sample(), provider: 'openai',
          recordedAtMs: now + index, weeklyQuota: { limitId: 'codex', resetsAt,
            usedPercentMillionths: used * 1000000, planType: 'plus' } })));
        const scope = { provider: 'openai', startAtMs: now, endAtMs: now + 1000 };
        assert.equal(store.quotaHistory(scope)[0].requestCount, 2);
        assert.equal(store.weeklyQuotaEstimate({ provider: 'openai', limitId: 'codex', resetsAt, nowMs: now + 1000 }).requestCount, 1);
        assert.throws(() => store.forEachProviderTokenMetric(scope, () => { throw new Error('visitor failed'); }), /visitor failed/);
        let count = 0;
        store.forEachProviderTokenMetric(scope, () => { global.gc(); count++; });
        assert.equal(count, 2);
        assert.equal(store.quotaHistory(scope)[0].requestCount, 2);
      } finally {
        store.close();
        StatementSync.prototype.iterate = originalIterate;
      }
    `, join(directory, "metrics.sqlite3")], { cwd: process.cwd(), stdio: "pipe", timeout: 15000 });
  });

  it("persists response and generation intervals independently of dumps without storing derived speeds", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"), 5_000);
    const generationTiming = { reasoningMs: 100, textMs: 200, toolMs: 300, totalMs: 600 };
    store.recordBatch([{ ...sample(), firstTokenMs: 200, totalDurationMs: 1000, responseTimeMs: 30, generationTiming }]);
    expect(store.recent(1)[0]).toMatchObject({ firstTokenMs: 200, totalDurationMs: 1000, responseTimeMs: 30, generationTiming });
    expect(() => store.recordBatch([{ ...sample(), totalDurationMs: 10, generationTiming }])).toThrow("请求生成计时无效");
    expect(store.recent(1)[0]).not.toHaveProperty("tokensPerSecond");
    expect(store.recent(1)[0]).not.toHaveProperty("generationTokensPerSecond");
    store.close();
  });
  it("persists TTFT and restores the first eligible sample for the exact Turn", () => {
    const path = join(temporaryDirectory(), "metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path, 5_000);
    const base = { ...sample(), provider: "openai", recordedAtMs: 2_000 };
    store.recordBatch([
      base,
      { ...base, turnId: "other", upstreamTtftMs: 10 },
      { ...base, threadId: "child", upstreamTtftMs: 20 },
      { ...base, operation: "compact", upstreamTtftMs: 30 },
      { ...base, provider: "deepseek", upstreamTtftMs: 40 },
      { ...base, upstreamTtftMs: 0 },
      { ...base, upstreamTtftMs: 720.25 },
    ]);
    expect(store.recent(1)[0]?.upstreamTtftMs).toBe(720.25);
    store.close();
    const reader = new SqliteModelRequestMetricsStore(path, 5_000, { readOnly: true });
    expect(reader.threadTurnSummary("thread-1", "turn-1")?.upstreamTtftMs).toBe(0);
    expect(reader.threadSummary("thread-1").latestTurn?.upstreamTtftMs).toBe(0);
    reader.close();
  });
  it("scopes Thread, Turn and request totals before grouping and pagination", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"), 5_000);
    store.recordBatch([
      { ...sample(), recordedAtMs: 999, model: "outside-before" },
      { ...sample(), recordedAtMs: 1_000, model: "matching" },
      { ...sample(), recordedAtMs: 1_200, turnId: "turn-2", model: "matching", status: "failed" },
      { ...sample(), recordedAtMs: 1_300, threadId: "thread-2", turnId: "turn-1", model: "matching" },
      { ...sample(), recordedAtMs: 2_000, model: "outside-after" },
      { ...sample(), recordedAtMs: 1_500, threadId: null, turnId: null, model: "matching" },
    ]);
    const query = { startAtMs: 1_000, endAtMs: 2_000, limit: 1, model: "matching" };
    const threads = store.threadList(query);
    expect(threads).toMatchObject({ matchedTotal: 2, turnCount: 3, nextOffset: 1, aggregate: { requestCount: 3, inputTokens: 3_000 } });
    expect(threads.threads[0]).toMatchObject({ threadId: "thread-2", model: "matching", requestCount: 1 });
    const next = store.threadList({ ...query, offset: 1 });
    expect(next).toMatchObject({ nextOffset: null, matchedTotal: 2 });
    expect(next.threads[0]).toMatchObject({ threadId: "thread-1", turnCount: 2, requestCount: 2, model: "matching" });
    expect(store.threadList({ ...query, offset: 9 })).toMatchObject({ threads: [], nextOffset: null, matchedTotal: 2 });
    const turns = store.threadTurnSummaries("thread-1", query);
    expect(turns).toMatchObject({ matchedTotal: 2, nextOffset: 1, aggregate: { requestCount: 2, unsuccessfulRequestCount: 1 } });
    expect(turns.turns[0]).toMatchObject({ turnId: "turn-2", requestCount: 1 });
    const scoped = { ...query, threadId: "thread-1", turnId: "turn-1" };
    const requests = store.page(scoped);
    expect(requests.records).toHaveLength(1);
    expect(requests.aggregate).toMatchObject({ requestCount: 1, inputTokens: 1_000 });
    expect(requests.aggregate).toEqual(store.aggregate({ ...scoped, dimension: "global" }).aggregate);
    expect(store.page({ ...query, filter: "thread-1" }).matchedTotal).toBe(2);
    expect(store.page({ ...query, threadId: "thread-1", status: "failed" }).matchedTotal).toBe(1);
    expect(store.errors({ ...query, threadId: "thread-1" })).toMatchObject({ requestCount: 2, unsuccessfulRequestCount: 1 });
    expect(() => store.page({ ...query, turnId: "turn-1" })).toThrow("必须同时指定 Thread");
    store.close();
  });

  it("uses recorded request status and literal keyword matching for scoped queries", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"), 5_000);
    store.recordBatch([
      { ...sample(), recordedAtMs: 1_000, status: "incomplete", incompleteReason: "response_not_observed", responseFormat: "unknown", model: null, inputTokens: null, outputTokens: null, totalTokens: null },
      { ...sample(), recordedAtMs: 1_000, model: "model_%" },
      { ...sample(), recordedAtMs: 1_000, model: "model-other" },
    ]);
    const query = { startAtMs: 0, endAtMs: 2_000, limit: 50 };
    expect(store.page({ ...query, status: "incomplete" }).records[0]?.status).toBe("incomplete");
    expect(store.page({ ...query, status: "completed" }).matchedTotal).toBe(2);
    expect(store.page({ ...query, filter: "_%" }).matchedTotal).toBe(1);
    store.close();
  });

  it("persists a bounded request batch", () => {
    const store = new SqliteModelRequestMetricsStore(
      join(temporaryDirectory(), "request-metrics.sqlite3"),
    );
    store.recordBatch([
      sample(),
      { ...sample(), threadId: "thread-2", turnId: "turn-2" },
    ]);

    expect(store.count()).toBe(2);
    expect(store.recent(2)).toEqual([
      expect.objectContaining({ threadId: "thread-2", turnId: "turn-2" }),
      expect.objectContaining({ threadId: "thread-1", turnId: "turn-1" }),
    ]);
    store.close();
  });

  it("幂等保存并读取最新官方账户快照", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"));
    store.upsertAccountSnapshot!({
      sourceId: "deepseek:default",
      provider: "deepseek",
      accountId: null,
      displayName: "DeepSeek",
      enabled: true,
      observedAtMs: 1_700_000_000_000,
      available: true,
      usage: { kind: "balance", provider: "deepseek", available: true, balances: [] },
      limits: { kind: "unsupported", provider: "deepseek" },
    });
    store.upsertAccountSnapshot!({
      sourceId: "deepseek:default",
      provider: "deepseek",
      accountId: null,
      displayName: "DeepSeek",
      enabled: true,
      observedAtMs: 1_700_000_000_001,
      available: false,
      usage: { kind: "unsupported", provider: "deepseek" },
      limits: { kind: "unsupported", provider: "deepseek" },
    });
    expect(store.latestAccountSnapshot!("deepseek")).toMatchObject({
      observedAtMs: 1_700_000_000_001,
      available: false,
    });
    expect(store.latestAccountSnapshots!()).toHaveLength(1);
    store.close();
  });

  it("retains each latest account fact through unrelated refresh and restart cleanup", () => {
    const path = join(temporaryDirectory(), "request-metrics.sqlite3");
    const start = 1_700_000_000_000;
    const day = 86_400_000;
    const store = new SqliteModelRequestMetricsStore(path, start, { retentionDays: 1 });
    const missing = {
      sourceId: "ocg-main:main", provider: "ocg-main", accountId: "main", displayName: "OCG",
      enabled: true, observedAtMs: start, available: false,
      usage: { kind: "subscription-required", provider: "ocg-main" },
      limits: { kind: "unsupported", provider: "ocg-main" },
    };
    store.upsertAccountSnapshot(missing);
    store.upsertAccountSnapshot({ ...missing, sourceId: "deepseek:default", provider: "deepseek",
      accountId: null, observedAtMs: start + 2 * day,
      usage: { kind: "balance", provider: "deepseek" } });
    expect(store.latestAccountSnapshot("ocg-main")?.usage).toEqual(missing.usage);
    store.close();
    const restarted = new SqliteModelRequestMetricsStore(path, start + 4 * day, { retentionDays: 1 });
    expect(restarted.latestAccountSnapshot("ocg-main")?.usage).toEqual(missing.usage);
    restarted.upsertAccountSnapshot({ ...missing, observedAtMs: start + 4 * day,
      available: true, usage: { kind: "quota-windows", provider: "ocg-main" } });
    expect(restarted.latestAccountSnapshot("ocg-main")?.usage).toMatchObject({ kind: "quota-windows" });
    restarted.close();
    const database = new DatabaseSync(path, { readOnly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM account_snapshots").get()).toEqual({ count: 2 });
    database.close();
  });

  it("cleans expired account snapshots when a source is refreshed", () => {
    const path = join(temporaryDirectory(), "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path, Date.now(), { retentionDays: 1 });
    const writeSnapshot = (observedAtMs: number) => store.upsertAccountSnapshot!({
      sourceId: "deepseek:default",
      provider: "deepseek",
      accountId: null,
      displayName: "DeepSeek",
      enabled: true,
      observedAtMs,
      available: true,
      usage: { kind: "balance", provider: "deepseek", available: true, balances: [] },
      limits: { kind: "unsupported", provider: "deepseek" },
    });
    writeSnapshot(1_700_000_000_000);
    writeSnapshot(1_700_172_800_000);
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database.prepare("SELECT COUNT(*) AS count FROM account_snapshots")
      .get() as { count: number };
    database.close();
    expect(row.count).toBe(1);
  });

  it("persists complete sanitized request metrics in a private standalone database", () => {
    const directory = temporaryDirectory();
    const statePath = join(directory, "gateway.sqlite3");
    const path = modelRequestMetricsDatabasePath(statePath);
    const store = new SqliteModelRequestMetricsStore(path);

    store.record(sample());

    expect(path).toBe(join(directory, "request-metrics.sqlite3"));
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(store.count()).toBe(1);
    expect(store.recent(1)[0]).toMatchObject({
      ...sample(),
      uncachedInputTokens: 100,
      cacheHitRate: 0.9,
    });
    store.close();
    const inspection = new DatabaseSync(path, { readOnly: true });
    const columns = inspection.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    inspection.close();
    expect(columns.map((column) => column.name).filter((name) =>
      name !== "error_message" && name !== "first_token_ms"
      && /body|content|prompt|message|image|authorization/iu.test(name)
    )).toEqual([]);
  });

  it("exposes derived timing, throughput and cache metrics", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);
    store.record(sample());
    expect(store.threadSummary("thread-1")).toMatchObject({
      latestTurn: {
        requestCount: 1,
      },
      threadAggregate: {
        requestCount: 1,
      },
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      requestCount: 1,
    });
    store.close();

    const inspection = new DatabaseSync(path, { readOnly: true });
    const legacyView = inspection.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'view' AND name = 'model_request_metrics_enriched'
    `).get();
    inspection.close();
    expect(legacyView).toBeUndefined();
  });

  it("estimates one percent from adjacent weekly quota changes", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    const resetsAt = Math.floor(Date.now() / 1_000) + 24 * 60 * 60;
    store.record({
      ...sample(),
      provider: "openai",
      weeklyQuota: {
        limitId: "codex",
        usedPercentMillionths: 10_000_000,
        resetsAt,
        planType: "plus",
      },
    });
    store.record({
      ...sample(),
      provider: "openai",
      inputTokens: 900,
      outputTokens: 100,
      totalTokens: 1_000,
      weeklyQuota: {
        limitId: "codex",
        usedPercentMillionths: 10_000_000,
        resetsAt,
        planType: "plus",
      },
    });
    store.record({
      ...sample(),
      provider: "openai",
      operation: "compact",
      inputTokens: 1_800,
      outputTokens: 200,
      totalTokens: 2_000,
      weeklyQuota: {
        limitId: "codex",
        usedPercentMillionths: 10_500_000,
        resetsAt,
        planType: "plus",
      },
    });

    expect(store.weeklyQuotaEstimate({
      provider: "openai",
      limitId: "codex",
      resetsAt,
      nowMs: Date.now() + 1,
    })).toMatchObject({
      intervalCount: 1,
      observedDeltaPercentMillionths: 500_000,
      requestCount: 2,
      inputTokens: 2_700,
      outputTokens: 300,
      totalTokens: 3_000,
    });
    store.close();
  });

  it("keeps the weekly quota high-water mark across reset jitter and backwards snapshots", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    const resetsAt = Math.floor(Date.now() / 1_000) + 24 * 60 * 60;
    for (const [usedPercentMillionths, resetOffset] of [
      [8_000_000, 300],
      [7_000_000, -300],
      [8_000_000, 1],
      [9_000_000, 0],
    ] as const) {
      store.record({
        ...sample(),
        provider: "openai",
        inputTokens: 900,
        outputTokens: 100,
        totalTokens: 1_000,
        weeklyQuota: {
          limitId: "codex",
          usedPercentMillionths,
          resetsAt: resetsAt + resetOffset,
          planType: "plus",
        },
      });
    }

    expect(store.weeklyQuotaEstimate({
      provider: "openai",
      limitId: "codex",
      resetsAt,
      nowMs: Date.now() + 1,
    })).toMatchObject({
      observedDeltaPercentMillionths: 1_000_000,
      intervalCount: 1,
      requestCount: 3,
      totalTokens: 3_000,
      periodRequestCount: 4,
      periodTotalTokens: 4_000,
    });
    store.close();
  });

  it("does not count recovery to the weekly quota high-water mark as new usage", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    const resetsAt = Math.floor(Date.now() / 1_000) + 24 * 60 * 60;
    for (const [usedPercentMillionths, inputTokens] of [
      [10_000_000, 10_000],
      [9_000_000, 9_000],
      [10_000_000, 1_000],
    ] as const) {
      store.record({
        ...sample(),
        provider: "openai",
        inputTokens,
        outputTokens: 0,
        totalTokens: inputTokens,
        weeklyQuota: {
          limitId: "codex",
          usedPercentMillionths,
          resetsAt,
          planType: null,
        },
      });
    }

    expect(store.weeklyQuotaEstimate({
      provider: "openai",
      limitId: "codex",
      resetsAt,
      nowMs: Date.now() + 1,
    })).toBeNull();
    store.close();
  });

  it("keeps request tokens through weekly percentage regressions until a new high-water mark", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    for (const [index, usedPercent] of [0, 1, 0, 1, 2].entries()) {
      store.record({
        ...sample(), provider: "openai", recordedAtMs: now + index,
        inputTokens: (index + 1) * 100, outputTokens: (index + 1) * 10,
        totalTokens: (index + 1) * 110,
        weeklyQuota: { limitId: "codex", resetsAt, usedPercentMillionths: usedPercent * 1_000_000, planType: null },
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 100 })).toMatchObject({
      intervalCount: 2,
      observedDeltaPercentMillionths: 2_000_000,
      latestUsedPercentMillionths: 2_000_000,
      requestCount: 4,
      inputTokens: 1_400,
      outputTokens: 140,
      totalTokens: 1_540,
      periodRequestCount: 5,
      periodInputTokens: 1_500,
      periodOutputTokens: 150,
      periodTotalTokens: 1_650,
    });
    store.close();
  });

  it.each([null, 1_000_000, 0])("excludes an unclosed weekly estimate tail with snapshot %s", (tailUsedPercentMillionths) => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    for (const [index, usedPercentMillionths] of [0, 1_000_000, tailUsedPercentMillionths].entries()) {
      store.record({
        ...sample(), provider: "openai", recordedAtMs: now + index,
        inputTokens: (index + 1) * 100, outputTokens: (index + 1) * 10,
        totalTokens: (index + 1) * 110,
        weeklyQuota: usedPercentMillionths === null ? null
          : { limitId: "codex", resetsAt, usedPercentMillionths, planType: null },
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 100 })).toMatchObject({
      intervalCount: 1,
      observedDeltaPercentMillionths: 1_000_000,
      latestUsedPercentMillionths: tailUsedPercentMillionths ?? 1_000_000,
      requestCount: 1,
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
      periodRequestCount: 3,
      periodInputTokens: 600,
      periodOutputTokens: 60,
      periodTotalTokens: 660,
    });
    store.close();
  });

  it.each([301, -301, 7 * 24 * 60 * 60])("breaks sampling at another weekly reset %s without recounting previous usage", (resetOffset) => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    const snapshots = [
      [0, resetsAt],
      [1_000_000, resetsAt],
      [0, resetsAt],
      [99_000_000, resetsAt + resetOffset],
      [null, null],
      [0, resetsAt],
      [1_000_000, resetsAt],
      [2_000_000, resetsAt],
    ] as const;
    for (const [index, [usedPercentMillionths, snapshotReset]] of snapshots.entries()) {
      store.record({
        ...sample(), provider: "openai", recordedAtMs: now + index,
        inputTokens: (index + 1) * 100, outputTokens: 0, totalTokens: (index + 1) * 100,
        weeklyQuota: usedPercentMillionths === null ? null
          : { limitId: "codex", resetsAt: snapshotReset, usedPercentMillionths, planType: null },
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 100 })).toMatchObject({
      intervalCount: 2,
      observedDeltaPercentMillionths: 2_000_000,
      requestCount: 3,
      inputTokens: 1_700,
      outputTokens: 0,
      totalTokens: 1_700,
      periodRequestCount: 8,
      periodTotalTokens: 3_600,
    });
    store.close();
  });

  it("isolates weekly quota high-water marks and token samples by provider", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    const snapshots = [
      ["openai", 0, 0],
      ["other-openai", 50_000_000, 0],
      ["openai", 1_000_000, 0],
      ["other-openai", 0, 7 * 24 * 60 * 60],
      ["openai", 0, 0],
      ["openai", 1_000_000, 0],
      ["openai", 2_000_000, 0],
    ] as const;
    for (const [index, [provider, usedPercentMillionths, resetOffset]] of snapshots.entries()) {
      store.record({
        ...sample(), provider, recordedAtMs: now + index,
        inputTokens: 100, outputTokens: 0, totalTokens: 100,
        weeklyQuota: { limitId: "codex", resetsAt: resetsAt + resetOffset,
          usedPercentMillionths, planType: null },
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 100 })).toMatchObject({
      intervalCount: 2,
      observedDeltaPercentMillionths: 2_000_000,
      requestCount: 4,
      totalTokens: 400,
      periodRequestCount: 5,
      periodTotalTokens: 500,
    });
    expect(store.weeklyQuotaEstimate({ provider: "other-openai", limitId: "codex", resetsAt, nowMs: now + 100 })).toBeNull();
    store.close();
  });

  it("persists quota observation times independently from insertion times without filling historical nulls", () => {
    const path = join(temporaryDirectory(), "metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    const weeklyQuota = { limitId: "codex" as const, resetsAt, usedPercentMillionths: 0, planType: null };
    store.record({ ...sample(), recordedAtMs: now, quotaObservedAtMs: now - 100, weeklyQuota });
    store.record({ ...sample(), recordedAtMs: now + 1, quotaObservedAtMs: now + 100,
      quotaWindows: [{ windowId: "weekly", resetsAt }] });
    store.record({ ...sample(), recordedAtMs: now + 2, weeklyQuota });
    store.record({ ...sample(), recordedAtMs: now + 3, quotaObservedAtMs: null, weeklyQuota });
    store.record({ ...sample(), recordedAtMs: now + 4, quotaObservedAtMs: null });
    store.close();

    const reader = new SqliteModelRequestMetricsStore(path, 5_000, { readOnly: true });
    expect(reader.requestRowsAfter(0, 10)).toMatchObject([
      { recordedAtMs: now, quotaObservedAtMs: now - 100, weeklyQuota },
      { recordedAtMs: now + 1, quotaObservedAtMs: now + 100, quotaWindows: [{ windowId: "weekly", resetsAt }] },
      { recordedAtMs: now + 2, quotaObservedAtMs: null },
      { recordedAtMs: now + 3, quotaObservedAtMs: null },
      { recordedAtMs: now + 4, quotaObservedAtMs: null },
    ]);
    expect(reader.recent(5).map((row) => row.quotaObservedAtMs)).toEqual([null, null, null, now + 100, now - 100]);
    reader.close();
  });

  it("rejects invalid quota observation times and observation times without a quota snapshot", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const weeklyQuota = { limitId: "codex" as const, resetsAt: 2_000_000_000, usedPercentMillionths: 0, planType: null };
    for (const quotaObservedAtMs of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => store.record({ ...sample(), weeklyQuota, quotaObservedAtMs })).toThrow();
    }
    expect(() => store.record({ ...sample(), quotaObservedAtMs: 1 })).toThrow();
    expect(() => store.record({ ...sample(), quotaObservedAtMs: 1, quotaWindows: [] })).toThrow();
    expect(store.requestRowsAfter(0, 10)).toEqual([]);
    store.close();
  });

  it.each([
    [0, 1, 2],
    [2, 0, 1],
    [2, 1, 0],
    [1, 2, 0],
  ])("orders quota snapshots by observation time when insertion order is %s, %s, %s", (...insertionOrder) => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    for (const [index, usedPercent] of insertionOrder.entries()) {
      store.record({
        ...sample(), provider: "openai", recordedAtMs: now + index * 1_000,
        quotaObservedAtMs: now + usedPercent * 100,
        inputTokens: (usedPercent + 1) * 100, outputTokens: 0, totalTokens: (usedPercent + 1) * 100,
        weeklyQuota: { limitId: "codex", resetsAt, usedPercentMillionths: usedPercent * 1_000_000, planType: null },
        quotaWindows: [{ windowId: "rolling", resetsAt, usedPercentMillionths: usedPercent * 1_000_000 }],
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 10_000 })).toMatchObject({
      firstObservedAtMs: now,
      lastObservedAtMs: now + 200,
      latestUsedPercentMillionths: 2_000_000,
      intervalCount: 2,
      observedDeltaPercentMillionths: 2_000_000,
      requestCount: 2,
      totalTokens: 500,
      periodRequestCount: 3,
      periodTotalTokens: 600,
    });
    expect(store.latestWeeklyQuota("openai", now + 10_000)).toMatchObject({
      usedPercentMillionths: 2_000_000,
      observedAtMs: now + 200,
    });
    const history = store.quotaHistory({ startAtMs: now, endAtMs: now + 10_000 });
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining(["codex", "rolling"].map((windowId) => expect.objectContaining({
      windowId,
      firstObservedAtMs: now,
      lastObservedAtMs: now + 200,
      latestUsedPercentMillionths: 2_000_000,
      snapshotCount: 3,
      totalTokens: 600,
    }))));
    store.close();
  });

  it("orders historical null observation times by insertion timestamp without filling the stored field", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    for (const usedPercent of [2, 0, 1]) {
      store.record({
        ...sample(), provider: "openai", recordedAtMs: now + usedPercent * 100,
        quotaObservedAtMs: null, inputTokens: (usedPercent + 1) * 100, outputTokens: 0,
        totalTokens: (usedPercent + 1) * 100,
        weeklyQuota: { limitId: "codex", resetsAt, usedPercentMillionths: usedPercent * 1_000_000, planType: null },
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 1_000 })).toMatchObject({
      firstObservedAtMs: now, lastObservedAtMs: now + 200,
      observedDeltaPercentMillionths: 2_000_000, intervalCount: 2, totalTokens: 500,
    });
    expect(store.latestWeeklyQuota("openai", now + 1_000)).toMatchObject({ usedPercentMillionths: 2_000_000, observedAtMs: now + 200 });
    expect(store.quotaHistory({ startAtMs: now, endAtMs: now + 1_000 })[0]).toMatchObject({
      firstObservedAtMs: now, lastObservedAtMs: now + 200, latestUsedPercentMillionths: 2_000_000,
    });
    expect(store.requestRowsAfter(0, 10).map((row) => row.quotaObservedAtMs)).toEqual([null, null, null]);
    store.close();
  });

  it("uses record ids to order quota snapshots sharing an observation timestamp", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    for (const usedPercent of [0, 1, 2]) {
      store.record({
        ...sample(), provider: "openai", recordedAtMs: now + (2 - usedPercent) * 100,
        quotaObservedAtMs: now, inputTokens: 100, outputTokens: 0, totalTokens: 100,
        weeklyQuota: { limitId: "codex", resetsAt, usedPercentMillionths: usedPercent * 1_000_000, planType: null },
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 1_000 })).toMatchObject({
      firstObservedAtMs: now, lastObservedAtMs: now,
      observedDeltaPercentMillionths: 2_000_000, intervalCount: 2, totalTokens: 200,
    });
    expect(store.latestWeeklyQuota("openai", now + 1_000)).toMatchObject({ usedPercentMillionths: 2_000_000, observedAtMs: now });
    expect(store.quotaHistory({ startAtMs: now, endAtMs: now + 1_000 })[0]).toMatchObject({
      firstObservedAtMs: now, lastObservedAtMs: now, latestUsedPercentMillionths: 2_000_000,
    });
    store.close();
  });

  it("keeps snapshots observed before the weekly period out of estimates while retaining period totals", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const resetsAt = Math.floor(now / 1_000) + 24 * 60 * 60;
    const periodStartAtMs = resetsAt * 1_000 - 7 * 24 * 60 * 60 * 1_000;
    for (const usedPercent of [0, 1, 2]) {
      store.record({
        ...sample(), provider: "openai", recordedAtMs: now + usedPercent,
        quotaObservedAtMs: usedPercent === 0 ? periodStartAtMs - 1 : now + usedPercent,
        inputTokens: (usedPercent + 1) * 100, outputTokens: 0, totalTokens: (usedPercent + 1) * 100,
        weeklyQuota: { limitId: "codex", resetsAt, usedPercentMillionths: usedPercent * 1_000_000, planType: null },
      });
    }

    expect(store.weeklyQuotaEstimate({ provider: "openai", limitId: "codex", resetsAt, nowMs: now + 1_000 })).toMatchObject({
      firstObservedAtMs: now + 1,
      lastObservedAtMs: now + 2,
      observedDeltaPercentMillionths: 1_000_000,
      intervalCount: 1,
      requestCount: 1,
      totalTokens: 300,
      periodRequestCount: 3,
      periodTotalTokens: 600,
    });
    store.close();
  });

  it("keeps unsuccessful requests in raw records and summaries", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record(sample());
    store.record({
      ...sample(),
      status: "failed",
      errorType: "http_error",
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_650,
    });
    store.record({
      ...sample(),
      status: "incomplete",
      incompleteReason: "max_output_tokens",
      requestStartedAtMs: 3_000,
      responseCompletedAtMs: 3_650,
    });

    expect(store.recent(3).map((record) => record.status))
      .toEqual(["incomplete", "failed", "completed"]);
    expect(store.threadSummary("thread-1")).toMatchObject({
      latestTurn: {
        requestCount: 3,
        unsuccessfulRequestCount: 2,
      },
      threadAggregate: {
        requestCount: 3,
        unsuccessfulRequestCount: 2,
      },
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      requestCount: 3,
      unsuccessfulRequestCount: 2,
    });
    expect(store.threadTurnSummaries("thread-1", { startAtMs: 0, endAtMs: Date.now() + 1, limit: 500 }).turns[0]).toMatchObject({
      requestCount: 3,
      unsuccessfulRequestCount: 2,
    });
    expect(store.threadList({ startAtMs: 0, endAtMs: Date.now() + 1, limit: 500 }).threads[0]).toMatchObject({
      requestCount: 3,
    });
    store.close();
  });

  it("annotates subagent threads in the thread list", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);
    store.record({
      ...sample(),
      threadId: "subagent-thread-1",
      turnId: "turn-1",
      model: "deepseek-v4-flash",
    });
    expect(store.threadList({ startAtMs: 0, endAtMs: Date.now() + 1, limit: 500 }).threads[0]).toMatchObject({
      threadId: "subagent-thread-1",
      agentPath: null,
    });

    store.recordSubagentThread({
      agentThreadId: "subagent-thread-1",
      parentThreadId: "parent-thread-1",
      parentTurnId: "parent-turn-1",
      agentPath: "/root/ds_probe",
    });
    expect(store.threadList({ startAtMs: 0, endAtMs: Date.now() + 1, limit: 500 }).threads[0]).toMatchObject({
      threadId: "subagent-thread-1",
      agentPath: "/root/ds_probe",
      parentThreadId: "parent-thread-1",
    });
    expect(store.subagentThread("subagent-thread-1")).toEqual({
      agentPath: "/root/ds_probe",
      parentThreadId: "parent-thread-1",
      parentTurnId: "parent-turn-1",
    });
    expect(store.subagentThread("unknown-thread")).toEqual({
      agentPath: null,
      parentThreadId: null,
      parentTurnId: null,
    });

    expect(() => store.recordSubagentThread({
      agentThreadId: "",
      parentThreadId: "parent-thread-1",
      parentTurnId: "turn-1",
      agentPath: "/root/ds_probe",
    })).toThrow("Thread ID 无效");
    store.close();
  });

  it("requires and persists the parent Turn for newly recorded subagents", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );

    expect(() => store.recordSubagentThread({
      agentThreadId: "subagent-1",
      parentThreadId: "parent-1",
      parentTurnId: "",
      agentPath: "/root/probe",
    })).toThrow(/父 Turn/u);

    store.recordSubagentThread({
      agentThreadId: "subagent-1",
      parentThreadId: "parent-1",
      parentTurnId: "turn-1",
      agentPath: "/root/probe",
    });
    expect(store.subagentThread("subagent-1")).toEqual({
      agentPath: "/root/probe",
      parentThreadId: "parent-1",
      parentTurnId: "turn-1",
    });
    expect(store.subagentThreadsAfter(0)[0]).toMatchObject({
      parentThreadId: "parent-1",
      parentTurnId: "turn-1",
    });
    store.close();
  });

  it("returns request rows incrementally after a local id", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record(sample());
    store.record({ ...sample(), inputTokens: 2_000, cachedInputTokens: 1_800 });
    store.record({ ...sample(), inputTokens: 3_000, cachedInputTokens: 2_700 });

    const first = store.requestRowsAfter(0, 2);
    expect(first.map((row) => row.id)).toEqual([1, 2]);
    expect(first[0]).toMatchObject({
      provider: "deepseek",
      inputTokens: 1_000,
    });

    const rest = store.requestRowsAfter(2, 2);
    expect(rest.map((row) => row.id)).toEqual([3]);

    expect(() => store.requestRowsAfter(-1, 10)).toThrow(/水位/u);
    expect(() => store.requestRowsAfter(0, 0)).toThrow(/批量/u);
    store.close();
  });

  it("round-trips quota window snapshots through raw records", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    const quotaWindows = [
      { windowId: "rolling", resetsAt: 1_800_000_000 },
      { windowId: "weekly", resetsAt: 1_900_000_000 },
      { windowId: "monthly", resetsAt: 2_000_000_000 },
    ];
    store.record({ ...sample(), quotaWindows });

    expect(store.requestRowsAfter(0, 10)[0]).toMatchObject({
      provider: "deepseek",
      quotaWindows,
    });
    expect(store.quotaHistory?.({
      startAtMs: 0,
      endAtMs: Number.MAX_SAFE_INTEGER,
    })).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "deepseek", windowId: "rolling", resetsAt: 1_800_000_000 }),
      expect.objectContaining({ provider: "deepseek", windowId: "weekly", resetsAt: 1_900_000_000 }),
      expect.objectContaining({ provider: "deepseek", windowId: "monthly", resetsAt: 2_000_000_000 }),
    ]));
    store.close();
  });

  it("keeps irregular OpenAI resets separate while merging jitter and early boundaries", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    const firstReset = 2_000_000;
    const irregularReset = firstReset + 57 * 60 * 60;
    for (const [resetsAt, usedPercentMillionths] of [
      [firstReset, 55_000_000],
      [irregularReset, 0],
      [irregularReset + 2, 1_000_000],
    ] as const) {
      store.record({
        ...sample(),
        provider: "openai",
        weeklyQuota: {
          limitId: "codex",
          usedPercentMillionths,
          resetsAt,
          planType: "plus",
        },
      });
    }

    const history = store.quotaHistory({
      startAtMs: 0,
      endAtMs: Number.MAX_SAFE_INTEGER,
    });
    expect(history).toHaveLength(2);
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resetsAt: firstReset,
        snapshotCount: 1,
        latestUsedPercentMillionths: 55_000_000,
        periodEndAtMs: (irregularReset - 7 * 24 * 60 * 60) * 1_000,
      }),
      expect.objectContaining({
        resetsAt: irregularReset,
        snapshotCount: 2,
        latestUsedPercentMillionths: 1_000_000,
      }),
    ]));
    store.close();
  });

  it("returns subagent thread records incrementally after recorded time", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.recordSubagentThread({
      agentThreadId: "subagent-1",
      parentThreadId: "parent-1",
      parentTurnId: "turn-1",
      agentPath: "/root/probe-a",
    });
    store.recordSubagentThread({
      agentThreadId: "subagent-2",
      parentThreadId: "parent-1",
      parentTurnId: "turn-1",
      agentPath: "/root/probe-b",
    });

    const first = store.subagentThreadsAfter(0);
    expect(first.map((row) => row.threadId).sort()).toEqual([
      "subagent-1",
      "subagent-2",
    ]);
    expect(first[0]).toMatchObject({
      parentThreadId: "parent-1",
      agentPath: "/root/probe-a",
    });

    const last = first[first.length - 1]!;
    expect(store.subagentThreadsAfter(last.recordedAtMs, last.threadId)).toEqual([]);
    expect(() => store.subagentThreadsAfter(-1)).toThrow(/水位/u);
    store.close();
  });

  it("advances the subagent cursor within the same recorded millisecond", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    vi.setSystemTime(new Date(1_700_000_000_000));
    store.recordSubagentThread({
      agentThreadId: "subagent-a",
      parentThreadId: "parent-1",
      parentTurnId: "turn-a",
      agentPath: "/root/probe-a",
    });
    vi.setSystemTime(new Date(1_700_000_000_001));
    store.recordSubagentThread({
      agentThreadId: "subagent-b",
      parentThreadId: "parent-1",
      parentTurnId: "turn-b",
      agentPath: "/root/probe-b",
    });

    const first = store.subagentThreadsAfter(0);
    expect(first.map((row) => row.threadId)).toEqual([
      "subagent-a",
      "subagent-b",
    ]);

    const remaining = store.subagentThreadsAfter(
      first[0]!.recordedAtMs,
      first[0]!.threadId,
    );
    expect(remaining.map((row) => row.threadId)).toEqual(["subagent-b"]);
    expect(store.subagentThreadsAfter(
      remaining[0]!.recordedAtMs,
      remaining[0]!.threadId,
    )).toEqual([]);
    store.close();
  });

  it("summarizes the latest Turn and whole Thread without a direct API branch", () => {
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
        inputTokens: 3_000,
        cachedInputTokens: 2_500,
        outputTokens: 300,
        reasoningOutputTokens: 90,
      },
      threadAggregate: {
        turnCount: 1,
        requestCount: 2,
        unsuccessfulRequestCount: 0,
        inputTokens: 3_000,
        cachedInputTokens: 2_500,
        outputTokens: 300,
        reasoningOutputTokens: 90,
      },
    });
    expect(store.threadSummary("thread-1")).not.toHaveProperty("latestDirectApi");
    store.close();
  });



});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-"));
  temporaryDirectories.push(directory);
  return directory;
}
