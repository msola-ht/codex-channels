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
    store.close();
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
      requestDurationMs: 650,
      totalCostNanos: null,
    });
    store.close();
    const inspection = new DatabaseSync(path, { readOnly: true });
    const columns = inspection.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    inspection.close();
    expect(columns.map((column) => column.name).filter((name) =>
      name !== "error_message"
      && /body|content|prompt|message|image|authorization/iu.test(name)
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
        pricedInputTokens: 1_000,
        pricedOutputTokens: 100,
        totalCostNanos: 1_400_000,
        uncachedInputPricePerMillionNanos: 2_000_000_000,
        cachedInputPricePerMillionNanos: 1_000_000_000,
        outputPricePerMillionNanos: 3_000_000_000,
        hasMixedPrices: false,
      },
      threadAggregate: {
        pricingCurrency: "USD",
        pricedRequestCount: 1,
        pricedInputTokens: 1_000,
        pricedOutputTokens: 100,
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

  it("keeps unsuccessful request prices in raw records but excludes them from cost summaries", () => {
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
      pricing,
      status: "failed",
      errorType: "http_error",
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_650,
    });
    store.record({
      ...sample(),
      pricing,
      status: "incomplete",
      incompleteReason: "max_output_tokens",
      requestStartedAtMs: 3_000,
      responseCompletedAtMs: 3_650,
    });

    expect(store.recent(3).map((record) => record.totalCostNanos))
      .toEqual([1_400_000, 1_400_000, 1_400_000]);
    expect(store.threadSummary("thread-1")).toMatchObject({
      latestTurn: {
        requestCount: 3,
        unsuccessfulRequestCount: 2,
        pricedRequestCount: 1,
        pricedInputTokens: 1_000,
        pricedOutputTokens: 100,
        totalCostNanos: 1_400_000,
      },
      threadAggregate: {
        requestCount: 3,
        unsuccessfulRequestCount: 2,
        pricedRequestCount: 1,
        pricedInputTokens: 1_000,
        pricedOutputTokens: 100,
        totalCostNanos: 1_400_000,
      },
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1,
    }).aggregate).toMatchObject({
      requestCount: 3,
      unsuccessfulRequestCount: 2,
      pricedRequestCount: 1,
      totalCostNanos: 1_400_000,
    });
    expect(store.threadTurnSummaries("thread-1")[0]).toMatchObject({
      requestCount: 3,
      unsuccessfulRequestCount: 2,
      pricedRequestCount: 1,
      pricedInputTokens: 1_000,
      pricedOutputTokens: 100,
      totalCostNanos: 1_400_000,
    });
    expect(store.threadList()[0]).toMatchObject({
      requestCount: 3,
      pricedRequestCount: 1,
      totalCostNanos: 1_400_000,
    });
    store.close();
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

  it("marks an aggregate as mixed buckets when priced requests lack a stored bucket", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    const base = {
      billingMode: "api" as const,
      currency: "USD",
      source: "test-catalog",
      effectiveAtMs: 1_700_000_000_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };
    store.record({ ...sample(), pricing: { ...base, bucket: "off-peak" } });
    store.record({
      ...sample(),
      pricing: base,
      requestStartedAtMs: 2_000,
      responseCompletedAtMs: 2_650,
    });

    expect(store.threadSummary("thread-1").latestTurn).toMatchObject({
      pricedRequestCount: 2,
      pricingBuckets: ["off-peak", "peak"],
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
    expect(store.threadList()[0]).toMatchObject({
      threadId: "subagent-thread-1",
      agentPath: null,
    });

    store.recordSubagentThread({
      agentThreadId: "subagent-thread-1",
      parentThreadId: "parent-thread-1",
      parentTurnId: "parent-turn-1",
      agentPath: "/root/ds_probe",
    });
    expect(store.threadList()[0]).toMatchObject({
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

});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-"));
  temporaryDirectories.push(directory);
  return directory;
}
