import { spawn } from "node:child_process";
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

  it.runIf(process.platform === "linux")(
    "recovers a legacy lock from before the current boot when its PID was reused",
    () => {
      const directory = temporaryDirectory();
      const path = join(directory, "request-metrics.sqlite3");
      const lockPath = `${path}.lock`;
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, token: "stale-owner" })}\n`,
        { mode: 0o600 },
      );
      const beforeCurrentBoot = new Date(0);
      utimesSync(lockPath, beforeCurrentBoot, beforeCurrentBoot);

      const lock = acquireRequestMetricsDatabaseLock(path);
      lock.release();

      expect(existsSync(lockPath)).toBe(false);
    },
  );

  it(
    "keeps a current-boot legacy lock with a live PID fail-closed",
    () => {
      const directory = temporaryDirectory();
      const path = join(directory, "request-metrics.sqlite3");
      const lockPath = `${path}.lock`;
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, token: "live-legacy-owner" })}\n`,
        { mode: 0o600 },
      );

      expect(() => acquireRequestMetricsDatabaseLock(path)).toThrow(/正在使用/u);
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  it.runIf(process.platform !== "linux")(
    "keeps an old legacy lock with a live PID fail-closed outside Linux",
    () => {
      const directory = temporaryDirectory();
      const path = join(directory, "request-metrics.sqlite3");
      const lockPath = `${path}.lock`;
      writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, token: "live-legacy-owner" })}\n`,
        { mode: 0o600 },
      );
      const old = new Date(0);
      utimesSync(lockPath, old, old);

      expect(() => acquireRequestMetricsDatabaseLock(path)).toThrow(/正在使用/u);
      expect(existsSync(lockPath)).toBe(true);
    },
  );

  it("keeps a lock held by the current process lifetime fail-closed", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const lockPath = `${path}.lock`;
    const owner = acquireRequestMetricsDatabaseLock(path);

    expect(() => acquireRequestMetricsDatabaseLock(path)).toThrow(/正在使用/u);
    expect(existsSync(`${lockPath}.sqlite3`)).toBe(true);
    expect(statSync(`${lockPath}.sqlite3`).mode & 0o777).toBe(0o600);

    owner.release();
    expect(existsSync(`${lockPath}.sqlite3`)).toBe(true);
  });

  it("uses a kernel lock that is released when its owner process exits", async () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const lockDatabasePath = `${path}.lock.sqlite3`;
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { DatabaseSync } from "node:sqlite";
const database = new DatabaseSync(process.argv[1]);
database.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
process.stdout.write("ready\\n");
setInterval(() => undefined, 1_000);`,
        lockDatabasePath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolveReady, rejectReady) => {
      owner.stdout.once("data", () => resolveReady());
      owner.once("error", rejectReady);
      owner.once("exit", (code) => rejectReady(new Error(`锁进程提前退出：${code}`)));
    });
    let unexpectedLock: ReturnType<typeof acquireRequestMetricsDatabaseLock> | undefined;
    try {
      expect(() => {
        unexpectedLock = acquireRequestMetricsDatabaseLock(path);
      }).toThrow(/正在使用/u);
    } finally {
      unexpectedLock?.release();
      owner.kill("SIGKILL");
      await new Promise<void>((resolveExit) => owner.once("exit", () => resolveExit()));
    }

    const recovered = acquireRequestMetricsDatabaseLock(path);
    recovered.release();
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

  it("keeps irregular OpenAI resets separate while merging reset timestamp jitter", () => {
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
    expect(store.threadTurnSummary("thread-1", "turn-1")).toMatchObject({
      turnId: "turn-1",
      requestCount: 1,
    });
    expect(store.threadTurnSummary("thread-1", "turn-2")).toMatchObject({
      turnId: "turn-2",
      requestCount: 1,
    });
    expect(store.threadTurnSummary("thread-1", "missing")).toBeNull();
    store.close();
  });

  it("recursively includes descendants in the root session aggregate without looping on cycles", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);
    store.record({ ...sample(), threadId: "root", turnId: "root-turn", inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    store.record({ ...sample(), threadId: "child", turnId: "child-turn", inputTokens: 200, outputTokens: 20, totalTokens: 220 });
    store.record({ ...sample(), threadId: "grandchild", turnId: "grand-turn", inputTokens: 300, outputTokens: 30, totalTokens: 330 });
    store.record({ ...sample(), threadId: "legacy-child", turnId: "legacy-turn", inputTokens: 400, outputTokens: 40, totalTokens: 440 });
    store.recordSubagentThread({
      agentThreadId: "child",
      parentThreadId: "root",
      parentTurnId: "root-turn",
      agentPath: "/root/child",
    });
    store.recordSubagentThread({
      agentThreadId: "grandchild",
      parentThreadId: "child",
      parentTurnId: "child-turn",
      agentPath: "/root/grandchild",
    });

    // Simulate a v9-era annotation: it remains part of the root session by
    // parent Thread, but cannot be attributed to any parent Turn.
    const raw = new DatabaseSync(path);
    raw.prepare(`
      INSERT INTO subagent_threads
        (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms)
      VALUES (?, ?, NULL, ?, ?)
    `).run("legacy-child", "root", "/root/legacy", Date.now());
    raw.prepare(`
      INSERT INTO subagent_threads
        (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run("root", "grandchild", "grand-turn", "/root/cycle", Date.now());
    raw.close();

    const summary = store.threadSummary("root");
    expect(summary.threadAggregate).toMatchObject({
      requestCount: 4,
      inputTokens: 1_000,
      outputTokens: 100,
      turnCount: 4,
    });
    expect(store.aggregate({
      dimension: "global",
      startAtMs: 0,
      endAtMs: Date.now() + 1_000,
    }).aggregate).toMatchObject({
      requestCount: 4,
      inputTokens: 1_000,
      outputTokens: 100,
    });
    store.close();
  });

  it("attributes only explicitly linked child threads to a parent Turn task aggregate", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({ ...sample(), threadId: "root", turnId: "turn-a", inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    store.record({ ...sample(), threadId: "root", turnId: "turn-b", inputTokens: 200, outputTokens: 20, totalTokens: 220 });
    store.record({ ...sample(), threadId: "child-a", turnId: "child-turn", inputTokens: 300, outputTokens: 30, totalTokens: 330 });
    store.record({ ...sample(), threadId: "grandchild", turnId: "grand-turn", inputTokens: 400, outputTokens: 40, totalTokens: 440 });
    store.record({ ...sample(), threadId: "child-b", turnId: "child-b-turn", inputTokens: 500, outputTokens: 50, totalTokens: 550 });
    store.record({ ...sample(), threadId: "legacy-child", turnId: "legacy-turn", inputTokens: 600, outputTokens: 60, totalTokens: 660 });
    store.recordSubagentThread({
      agentThreadId: "child-a",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/a",
    });
    store.recordSubagentTurn({
      agentThreadId: "child-a",
      agentTurnId: "child-turn",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/a",
    });
    store.recordSubagentThread({
      agentThreadId: "grandchild",
      parentThreadId: "child-a",
      parentTurnId: "child-turn",
      agentPath: "/root/grandchild",
    });
    store.recordSubagentTurn({
      agentThreadId: "grandchild",
      agentTurnId: "grand-turn",
      parentThreadId: "child-a",
      parentTurnId: "child-turn",
      agentPath: "/root/grandchild",
    });
    store.recordSubagentThread({
      agentThreadId: "child-b",
      parentThreadId: "root",
      parentTurnId: "turn-b",
      agentPath: "/root/b",
    });
    store.recordSubagentTurn({
      agentThreadId: "child-b",
      agentTurnId: "child-b-turn",
      parentThreadId: "root",
      parentTurnId: "turn-b",
      agentPath: "/root/b",
    });
    const raw = new DatabaseSync(join(directory, "request-metrics.sqlite3"));
    raw.prepare(`
      INSERT INTO subagent_threads
        (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms)
      VALUES (?, ?, NULL, ?, ?)
    `).run("legacy-child", "root", "/root/legacy", Date.now());
    raw.close();

    expect(store.threadTurnTaskSummary("root", "turn-a")).toMatchObject({
      turnId: "turn-a",
      requestCount: 3,
      inputTokens: 800,
      outputTokens: 80,
    });
    expect(store.threadTurnTaskSummary("root", "turn-b")).toMatchObject({
      turnId: "turn-b",
      requestCount: 2,
      inputTokens: 700,
      outputTokens: 70,
    });
    store.close();
  });

  it("attributes repeated runs of one subagent Thread to their exact parent Turns", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({
      ...sample(),
      threadId: "root",
      turnId: "parent-turn-a",
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
    });
    store.record({
      ...sample(),
      threadId: "root",
      turnId: "parent-turn-b",
      inputTokens: 200,
      outputTokens: 20,
      totalTokens: 220,
    });
    store.record({
      ...sample(),
      threadId: "child",
      turnId: "child-turn-a",
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
    });
    store.record({
      ...sample(),
      threadId: "child",
      turnId: "child-turn-b",
      inputTokens: 400,
      outputTokens: 40,
      totalTokens: 440,
    });
    store.recordSubagentThread({
      agentThreadId: "child",
      parentThreadId: "root",
      parentTurnId: "parent-turn-a",
      agentPath: "/root/child",
    });
    store.recordSubagentTurn({
      agentThreadId: "child",
      agentTurnId: "child-turn-a",
      parentThreadId: "root",
      parentTurnId: "parent-turn-a",
      agentPath: "/root/child",
    });
    store.recordSubagentTurn({
      agentThreadId: "child",
      agentTurnId: "child-turn-b",
      parentThreadId: "root",
      parentTurnId: "parent-turn-b",
      agentPath: "/root/child",
    });

    expect(store.threadTurnTaskSummary("root", "parent-turn-a")).toMatchObject({
      requestCount: 2,
      inputTokens: 400,
      outputTokens: 40,
    });
    expect(store.threadTurnTaskSummary("root", "parent-turn-b")).toMatchObject({
      requestCount: 2,
      inputTokens: 600,
      outputTokens: 60,
    });
    store.close();
  });

  it("keeps a zero task summary when a linked child has no model rows yet", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({ ...sample(), threadId: "root", turnId: "turn-a" });
    store.recordSubagentThread({
      agentThreadId: "child",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/child",
    });
    store.recordSubagentTurn({
      agentThreadId: "child",
      agentTurnId: "child-turn",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/child",
    });

    expect(store.threadTurnTaskSummary("root", "turn-a")).toMatchObject({
      turnId: "turn-a",
      requestCount: 1,
      inputTokens: 1_000,
      outputTokens: 100,
    });
    store.recordSubagentThread({
      agentThreadId: "empty-child",
      parentThreadId: "empty-root",
      parentTurnId: "turn-a",
      agentPath: "/root/empty",
    });
    store.recordSubagentTurn({
      agentThreadId: "empty-child",
      agentTurnId: "empty-child-turn",
      parentThreadId: "empty-root",
      parentTurnId: "turn-a",
      agentPath: "/root/empty",
    });
    expect(store.threadTurnTaskSummary("empty-root", "turn-a")).toMatchObject({
      turnId: "turn-a",
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(store.threadTurnTaskSummary("root", "turn-b")).toBeNull();
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

  it("removes records older than a custom retention when reopened", () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const initialTime = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(initialTime);
    const first = new SqliteModelRequestMetricsStore(path);
    first.record(sample());
    first.close();

    vi.setSystemTime(new Date("2026-04-02T00:00:00.001Z"));
    const reopened = new SqliteModelRequestMetricsStore(path, undefined, {
      retentionDays: 90,
    });

    expect(reopened.count()).toBe(0);
    reopened.close();
  });

  it("keeps only a custom maximum number of rows when reopened", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const first = new SqliteModelRequestMetricsStore(path);
    first.record(sample());
    first.record({ ...sample(), threadId: "thread-2", turnId: "turn-2" });
    first.close();

    const reopened = new SqliteModelRequestMetricsStore(path, undefined, {
      maximumRows: 1,
    });

    expect(reopened.count()).toBe(1);
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
      sortDirection: "asc",
    });
    expect(first.records).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    const second = reader.page({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
      offset: first.nextOffset ?? 0,
      limit: 1,
      sortDirection: "asc",
    });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.id).not.toBe(first.records[0]?.id);
    expect(second.nextOffset).toBeNull();
    expect(() => reader.record(sample())).toThrow(/只读/u);
    reader.close();
    writer.close();
  });

  it("filters request pages across the whole range", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({
      ...sample(),
      provider: "openai",
      model: "gpt-5.6-sol",
      status: "failed",
      errorType: "usage_limit_reached",
      errorMessage: "You've hit your usage limit",
    });
    store.record({
      ...sample(),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      status: "completed",
    });
    store.record({
      ...sample(),
      provider: "openai",
      model: "gpt-5.6-sol",
      status: "completed",
    });

    const byError = store.page({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
      limit: 10,
      filter: "usage limit",
    });
    expect(byError.matchedTotal).toBe(1);
    expect(byError.records).toHaveLength(1);
    expect(byError.records[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.6-sol",
      errorType: "usage_limit_reached",
    });

    const byModel = store.page({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
      limit: 10,
      filter: "deepseek",
    });
    expect(byModel.matchedTotal).toBe(1);
    expect(byModel.records[0]?.provider).toBe("deepseek");

    const literalWildcard = store.page({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
      limit: 10,
      filter: "%",
    });
    expect(literalWildcard.matchedTotal).toBe(0);
    expect(() => store.page({
      startAtMs: 0,
      endAtMs: Date.now() + 1,
      limit: 10,
      filter: "x".repeat(129),
    })).toThrow(/最多 128/u);
    store.close();
  });
});

describe("BufferedModelRequestMetricsWriter", () => {
  it("writes at most one synchronous SQLite record per scheduled turn", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const writer = new BufferedModelRequestMetricsWriter({
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
      recordSubagentThread: () => undefined,
      recordSubagentTurn: () => undefined,
      requestRowsAfter: () => [],
      subagentThreadsAfter: () => [],
      recent: () => [],
      aggregate: () => emptyMetricsReport(),
      threadTurnTaskSummary: () => null,
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

  it("resolves a persistence checkpoint after the writes already enqueued", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>();
    const writer = new BufferedModelRequestMetricsWriter({
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
      close: () => undefined,
    });
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
    expect(await persistenceCheckpoint).toBe(true);
    await checkpoint;
    expect(checkpointResolved).toBe(true);
    expect(record).toHaveBeenCalledTimes(3);

    await writer.close();
    expect(record).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it("reports a failed write through the matching thread checkpoint", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>(() => {
      throw new Error("disk full");
    });
    const writer = new BufferedModelRequestMetricsWriter({
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
      close: () => undefined,
    });
    writer.enqueue(sample());

    const checkpoint = writer.waitForCurrentWrites("thread-1");
    await vi.advanceTimersByTimeAsync(10);

    await expect(checkpoint).resolves.toBe(false);
    await writer.close();
    vi.useRealTimers();
  });

  it("does not fail a thread checkpoint for another thread's write", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>((metric) => {
      if (metric.threadId === "thread-2") throw new Error("disk full");
    });
    const writer = new BufferedModelRequestMetricsWriter({
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
      close: () => undefined,
    });
    writer.enqueue({ ...sample(), threadId: "thread-2" });
    writer.enqueue(sample());

    const checkpoint = writer.waitForCurrentWrites("thread-1");
    await vi.advanceTimersByTimeAsync(20);

    await expect(checkpoint).resolves.toBe(true);
    await writer.close();
    vi.useRealTimers();
  });

  it("does not fail a Turn checkpoint for another Turn in the same Thread", async () => {
    vi.useFakeTimers();
    const record = vi.fn<ModelRequestMetricsStore["record"]>((metric) => {
      if (metric.turnId === "turn-2") throw new Error("disk full");
    });
    const writer = new BufferedModelRequestMetricsWriter({
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
      close: () => undefined,
    });
    writer.enqueue({ ...sample(), turnId: "turn-2" });
    writer.enqueue(sample());

    const checkpoint = writer.waitForCurrentWrites("thread-1", "turn-1");
    await vi.advanceTimersByTimeAsync(20);

    await expect(checkpoint).resolves.toBe(true);
    await writer.close();
    vi.useRealTimers();
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
