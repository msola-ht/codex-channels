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

  it("derives request speed and pools output over eligible request time across scopes", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"), 5_000);
    const base = { ...sample(), recordedAtMs: 2_000 };
    store.recordBatch([
      { ...base, outputTokens: 100, totalDurationMs: 1_000 },
      { ...base, outputTokens: 900, totalDurationMs: 3_000 },
      { ...base, outputTokens: 99_999 },
      { ...base, outputTokens: 100, totalDurationMs: 0 },
      { ...base, outputTokens: 0, totalDurationMs: 1_000 },
      { ...base, outputTokens: null, totalDurationMs: 1_000 },
      { ...base, threadId: "other", outputTokens: 900, totalDurationMs: 1_000 },
    ]);
    expect(store.recent(7).map((row) => row.tokensPerSecond)).toEqual([900, null, null, null, null, 300, 100]);
    expect(store.threadTurnSummary("thread-1", "turn-1")?.tokensPerSecond).toBe(250);
    expect(store.threadSummary("thread-1").threadAggregate?.tokensPerSecond).toBe(250);
    const scope = { startAtMs: 1_000, endAtMs: 3_000, limit: 1, sortKey: "tokensPerSecond" as const, sortDirection: "desc" as const };
    expect(store.threadList(scope).threads[0]).toMatchObject({ threadId: "other", tokensPerSecond: 900 });
    expect(store.threadTurnSummaries("thread-1", scope).turns[0]?.tokensPerSecond).toBe(250);
    expect(store.page(scope).records[0]?.tokensPerSecond).toBe(900);
    store.recordSubagentThread({ agentThreadId: "other", parentThreadId: "thread-1", parentTurnId: "turn-1", agentPath: "/root/child" });
    expect(store.threadSummary("thread-1").threadAggregate?.tokensPerSecond).toBe(380);
    expect(store.threadList({ ...scope, threadId: "thread-1" }).threads[0]?.tokensPerSecond).toBe(250);
    store.close();
  });
  it("counts reasoning tokens in the output rate and ignores the first-content window", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"), 5_000);
    const base = { ...sample(), recordedAtMs: 2_000, turnId: "turn-rate" };
    store.recordBatch([
      { ...base, outputTokens: 100, reasoningOutputTokens: 40, totalDurationMs: 1_000, firstContentMs: 200 },
      { ...base, outputTokens: 100, reasoningOutputTokens: null, totalDurationMs: 1_000, firstContentMs: 800 },
      { ...base, outputTokens: 100, reasoningOutputTokens: 0, totalDurationMs: 1_000, firstContentMs: 901 },
      { ...base, outputTokens: 40, reasoningOutputTokens: 40, totalDurationMs: 1_000 },
    ]);
    // 推理 Token 计入分子；首字耗时只体现在分母的总耗时里，不再单独扣解码窗口。
    expect(store.recent(4).map((row) => row.tokensPerSecond)).toEqual([40, 100, 100, 100]);
    // 合计相除：340 Token / 4 秒，缺少首字样本的记录同样参与。
    expect(store.threadTurnSummary("thread-1", "turn-rate")?.tokensPerSecond).toBe(85);
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

  it("uses normalized request status and literal keyword matching for scoped queries", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"), 5_000);
    store.recordBatch([
      { ...sample(), recordedAtMs: 1_000, responseFormat: "unknown", model: null, inputTokens: null, outputTokens: null, totalTokens: null },
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
      name !== "error_message" && name !== "first_content_ms"
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

  it.each(["ocg-main", "clp-main"])("derives %s quota ratios from persisted snapshots without mixing windows or open intervals", (provider) => {
    const path = join(temporaryDirectory(), "metrics.sqlite3");
    const now = Date.now();
    const resetsAt = Math.floor(now / 1000) + 3600;
    const store = new SqliteModelRequestMetricsStore(path);
    const snapshot = (offset: number, weekly: number, monthly: number, reset = resetsAt, available = true) => {
      store.upsertAccountSnapshot({ sourceId: provider, provider, accountId: "main", displayName: provider,
        enabled: true, observedAtMs: now + offset, available,
        usage: { kind: available ? "quota-windows" : "subscription-required", provider, available,
          windows: [{ windowId: "weekly", usedPercent: weekly, resetsAt: reset },
            { windowId: "monthly", usedPercent: monthly, resetsAt: resetsAt + 3600 },
            { windowId: "unknown-reset", usedPercent: 10, resetsAt: null }] },
        limits: { kind: "unsupported", provider } });
    };
    const metric = (offset: number, tokens: number, target = provider) => store.record({
      ...sample(), provider: target, recordedAtMs: now + offset, requestStartedAtMs: now + offset - 1, responseCompletedAtMs: now + offset,
      inputTokens: tokens, outputTokens: 0, totalTokens: tokens,
    });
    snapshot(0, 10, 20);
    expect(store.accountQuotaEstimates(provider, now)).toEqual([
      { windowId: "weekly", resetsAt, tokenEstimate: { status: "sampling" } },
      { windowId: "monthly", resetsAt: resetsAt + 3600, tokenEstimate: { status: "sampling" } },
    ]);
    metric(10, 1100);
    snapshot(20, 10, 20);
    metric(30, 900);
    metric(31, 99999, "ocg-other");
    snapshot(40, 12, 21);
    metric(50, 9999);
    snapshot(60, 12, 21);
    let ready = store.accountQuotaEstimates(provider, now + 60);
    expect(ready).toMatchObject([
      { tokenEstimate: { status: "ready", tokensPerPercent: 1000, observedDeltaPercent: 2, intervalCount: 1, requestCount: 2 } },
      { tokenEstimate: { status: "ready", tokensPerPercent: 2000, observedDeltaPercent: 1, intervalCount: 1, requestCount: 2 } },
    ]);
    snapshot(70, 13, 21);
    ready = store.accountQuotaEstimates(provider, now + 70);
    expect(ready[0]?.tokenEstimate).toEqual({ status: "ready", tokensPerPercent: 11999 / 3,
      observedDeltaPercent: 3, intervalCount: 2, requestCount: 3 });
    expect(ready[1]?.tokenEstimate).toMatchObject({ tokensPerPercent: 2000, intervalCount: 1 });
    expect(JSON.stringify(store.latestAccountSnapshot(provider)?.usage)).not.toContain("tokenEstimate");
    store.close();
    const reopened = new SqliteModelRequestMetricsStore(path, now + 60, { readOnly: true });
    expect(reopened.accountQuotaEstimates(provider, now + 70)).toEqual(ready);
    expect(reopened.accountQuotaEstimates(provider, resetsAt * 1000)[0]?.tokenEstimate).toEqual({ status: "sampling" });
    reopened.close();
  });

  it.each(["reset", "backwards", "missing", "no-local-tokens", "missing-tokens"])("does not invent quota ratios after %s", (condition) => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const now = Date.now();
    const provider = "clp-main";
    const resetsAt = Math.floor(now / 1000) + 3600;
    const write = (at: number, percent: number, reset: number, available = true) => store.upsertAccountSnapshot({
      sourceId: provider, provider, accountId: "main", displayName: provider, enabled: true,
      observedAtMs: now + at, available, usage: { kind: available ? "quota-windows" : "subscription-required", available,
        windows: [{ windowId: "weekly", resetsAt: reset, usedPercent: percent }] }, limits: {},
    });
    write(0, 10, resetsAt);
    if (condition !== "no-local-tokens") store.record({ ...sample(), provider, recordedAtMs: now + 10, requestStartedAtMs: now + 5, responseCompletedAtMs: now + 9,
      inputTokens: condition === "missing-tokens" ? null : 1000 });
    if (condition === "missing") write(15, 10, resetsAt, false);
    write(20, condition === "backwards" ? 9 : 12, condition === "reset" ? resetsAt + 100 : resetsAt);
    expect(store.accountQuotaEstimates(provider, now + 20)[0]?.tokenEstimate).toEqual({ status: "sampling" });
    store.close();
  });

  it.each(["ocg-main", "clp-main"])("assigns %s delayed writes by actual request time, including writes after the last snapshot", (provider) => {
    const now = Date.now();
    const resetsAt = Math.floor(now / 1000) + 3600;
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const snapshot = (at: number, usedPercent: number) => store.upsertAccountSnapshot({
      sourceId: provider, provider, accountId: null, displayName: provider, enabled: true,
      observedAtMs: now + at, available: true, limits: {}, usage: { kind: "quota-windows", available: true,
        windows: [{ windowId: "weekly", resetsAt, usedPercent }] },
    });
    snapshot(0, 10);
    snapshot(100, 12);
    snapshot(200, 13);
    store.recordBatch([
      { ...sample(), provider, requestStartedAtMs: now + 20, responseCompletedAtMs: now + 80,
        recordedAtMs: now + 110, inputTokens: 2000, outputTokens: 0 },
      { ...sample(), provider, requestStartedAtMs: now + 140, responseCompletedAtMs: now + 160,
        recordedAtMs: now + 210, inputTokens: 1000, outputTokens: 0 },
      // Already completed before the baseline, even though persistence was delayed.
      { ...sample(), provider, requestStartedAtMs: now - 20, responseCompletedAtMs: now - 10,
        recordedAtMs: now + 50, inputTokens: 99999, outputTokens: 0 },
    ]);
    expect(store.accountQuotaEstimates(provider, now + 200)[0]?.tokenEstimate).toMatchObject({
      status: "ready", tokensPerPercent: 1000, intervalCount: 1, requestCount: 1,
    });
    expect(store.readSnapshot(() => store.accountQuotaEstimates(provider, now + 220))[0]?.tokenEstimate).toEqual({
      status: "ready", tokensPerPercent: 1000, observedDeltaPercent: 3, intervalCount: 2, requestCount: 2,
    });
    store.close();
  });

  it.each([-20, 20])("excludes every interval touched by a request starting at %s across snapshots, then recovers", (start) => {
    const now = Date.now();
    const provider = "clp-main";
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "metrics.sqlite3"));
    const snapshot = (at: number, usedPercent: number) => store.upsertAccountSnapshot({
      sourceId: provider, provider, accountId: null, displayName: provider, enabled: true,
      observedAtMs: now + at, available: true, limits: {}, usage: { kind: "quota-windows", available: true,
        windows: [{ windowId: "weekly", resetsAt: Math.floor(now / 1000) + 3600, usedPercent }] },
    });
    snapshot(0, 10); snapshot(100, 12); snapshot(200, 14);
    store.recordBatch([
      { ...sample(), provider, requestStartedAtMs: now + start, responseCompletedAtMs: now + 150,
        recordedAtMs: now + 160 },
      { ...sample(), provider, requestStartedAtMs: now + 50, responseCompletedAtMs: now + 60,
        recordedAtMs: now + 70 },
      { ...sample(), provider, requestStartedAtMs: now + 170, responseCompletedAtMs: now + 180,
        recordedAtMs: now + 190 },
    ]);
    expect(store.accountQuotaEstimates(provider, now + 200)[0]?.tokenEstimate).toEqual({ status: "sampling" });
    store.record({ ...sample(), provider, requestStartedAtMs: now + 200, responseCompletedAtMs: now + 250,
      recordedAtMs: now + 260, inputTokens: 1000, outputTokens: 0 });
    snapshot(300, 15);
    expect(store.accountQuotaEstimates(provider, now + 300)[0]?.tokenEstimate).toMatchObject({
      status: "ready", tokensPerPercent: 1000, intervalCount: 1, requestCount: 1,
    });
    store.close();
  });

  it.each([false, true])("rebuilds the baseline after row retention (other provider: %s)", (otherProvider) => {
    const now = Date.now();
    const provider = "clp-main";
    const path = join(temporaryDirectory(), "metrics.sqlite3");
    let store = new SqliteModelRequestMetricsStore(path, now, { maximumRows: 1 });
    const snapshot = (at: number, usedPercent: number) => store.upsertAccountSnapshot({
      sourceId: provider, provider, accountId: null, displayName: provider, enabled: true,
      observedAtMs: now + at, available: true, limits: {}, usage: { kind: "quota-windows", available: true,
        windows: [{ windowId: "weekly", resetsAt: Math.floor(now / 1000) + 3600, usedPercent }] },
    });
    snapshot(0, 10);
    store.recordBatch([1100, 900].map((inputTokens, index) => ({ ...sample(), provider, inputTokens, outputTokens: 0,
      requestStartedAtMs: now + 10 + index * 20, responseCompletedAtMs: now + 15 + index * 20,
      recordedAtMs: now + 20 + index * 20 })));
    snapshot(50, 12);
    expect(store.accountQuotaEstimates(provider, now + 60)[0]?.tokenEstimate).toMatchObject({ tokensPerPercent: 1000 });
    // A different provider can cause global cleanup of this account's requests.
    if (otherProvider) store.record({ ...sample(), provider: "ocg-other", recordedAtMs: now + 55,
      requestStartedAtMs: now + 51, responseCompletedAtMs: now + 54 });
    store.close();
    store = new SqliteModelRequestMetricsStore(path, now + 60, { maximumRows: 1 });
    const truncated = store.accountQuotaEstimates(provider, now + 60);
    if (otherProvider) expect(truncated).toEqual([]);
    else expect(truncated[0]?.tokenEstimate).toEqual({ status: "sampling" });
    snapshot(70, 12);
    expect(store.accountQuotaEstimates(provider, now + 70)[0]?.tokenEstimate).toEqual({ status: "sampling" });
    store.record({ ...sample(), provider, requestStartedAtMs: now + 80, responseCompletedAtMs: now + 90,
      recordedAtMs: now + 95, inputTokens: 2000, outputTokens: 0 });
    snapshot(100, 14);
    const expected = store.accountQuotaEstimates(provider, now + 100);
    expect(expected[0]?.tokenEstimate).toMatchObject({ tokensPerPercent: 1000, intervalCount: 1, requestCount: 1 });
    store.close();
    const reader = new SqliteModelRequestMetricsStore(path, now + 100, { readOnly: true });
    expect(reader.accountQuotaEstimates(provider, now + 100)).toEqual(expected);
    reader.close();
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

  it("estimates a weekly quota across small reset timestamp jitter", () => {
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
        usedPercentMillionths: 8_000_000,
        resetsAt: resetsAt + 2,
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
        usedPercentMillionths: 9_000_000,
        resetsAt: resetsAt + 1,
        planType: "plus",
      },
    });

    expect(store.weeklyQuotaEstimate({
      provider: "openai",
      limitId: "codex",
      resetsAt,
      nowMs: Date.now() + 1,
    })).toMatchObject({
      observedDeltaPercentMillionths: 1_000_000,
      intervalCount: 1,
      requestCount: 1,
      totalTokens: 1_000,
    });
    store.close();
  });

  it("breaks a weekly estimate interval when the percentage moves backwards", () => {
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
    })).toMatchObject({
      observedDeltaPercentMillionths: 1_000_000,
      requestCount: 1,
      totalTokens: 1_000,
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
