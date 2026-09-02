import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    readPrivateFileSync: (path: string) => readFileSync(path, "utf8"),
    assertPrivateFileAccessSync: () => undefined,
    assertPrivateDirectoryAccessSync: () => undefined,
  };
});

import {
  createOpencodeGoAccountAdapter,
  createOpencodeGoRemainingUsageReader,
  opencodeGoMonthlyWindowStartMs,
} from "../src/bootstrap/opencode-go-account-adapter.js";
import {
  SqliteModelRequestMetricsStore,
  modelRequestMetricsDatabasePath,
} from "../src/observability/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("OpenCode Go account adapter", () => {
  it("reads the managed profile credential and maps quota windows", async () => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 0, resetsAt: "2026-08-16T18:03:54.934Z" },
        weekly: { status: "ok", percent: 2, resetsAt: "2026-08-17T00:00:00.934Z" },
        monthly: { status: "ok", percent: 1, resetsAt: "2026-09-15T14:22:07.934Z" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toEqual({
      kind: "quota-windows",
      provider: "ocg-main",
      available: true,
      windows: [
        {
          windowId: "rolling",
          label: "5小时",
          usedPercent: 0,
          resetsAt: Math.floor(Date.parse("2026-08-16T18:03:54.934Z") / 1_000),
          status: "ok",
          totalUsd: 12,
        },
        {
          windowId: "weekly",
          label: "7天",
          usedPercent: 2,
          resetsAt: Math.floor(Date.parse("2026-08-17T00:00:00.934Z") / 1_000),
          status: "ok",
          totalUsd: 30,
        },
        {
          windowId: "monthly",
          label: "月度",
          usedPercent: 1,
          resetsAt: Math.floor(Date.parse("2026-09-15T14:22:07.934Z") / 1_000),
          status: "ok",
          totalUsd: 60,
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer sk-test-secret" }),
      }),
    );
  });

  it("reads the default account credential after migrating to the account registry", async () => {
    const codexHome = await createAccountRegistryCodexHome();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-08-16T18:03:54.934Z" },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({
      kind: "quota-windows",
      provider: "ocg-main",
      available: true,
      windows: [{ windowId: "rolling", usedPercent: 10 }],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: "Bearer sk-test-secret" }),
      }),
    );
  });

  it("fails with a stable user error without exposing malformed responses", async () => {
    const codexHome = await createCodexHome();
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: async () => new Response("secret-upstream-body", { status: 200 }),
    });

    await expect(adapter.accountUsage()).rejects.toMatchObject({
      code: "provider.account.unavailable",
      message: "OpenCode Go 账户查询失败",
    });
  });

  it("falls back to the fixed-mode base config when no managed profile exists", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "codexc-opencode-go-fixed-account-"));
    temporaryDirectories.push(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      `model = "deepseek-v4-flash"\n${providerConfig("sk-fixed-secret")}`,
      { mode: 0o600 },
    );
    await createAccountRegistry(codexHome, "exclusive");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-08-16T18:03:54.934Z" },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({
      kind: "quota-windows",
      provider: "ocg-main",
      available: true,
      windows: [{ windowId: "rolling", usedPercent: 10 }],
    });
  });

  it("skips invalid windows and rejects when none remain", async () => {
    const codexHome = await createCodexHome();
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: async () => new Response(JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: "broken", resetsAt: "not-a-date" },
        },
      }), { status: 200 }),
    });

    await expect(adapter.accountUsage()).rejects.toMatchObject({
      code: "provider.account.unavailable",
      message: "OpenCode Go 账户查询失败",
    });
  });

  it("includes local per-model usage estimates from the metrics database", async () => {
    const codexHome = await createCodexHome();
    const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-metrics-"));
    temporaryDirectories.push(directory);
    const nowMs = Date.parse("2026-08-19T00:00:00.000Z");
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    store.record({
      provider: "ocg-main",
      pricing: null,
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-1",
      turnId: "turn-1",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      reasoningEffort: "high",
      status: "completed",
      httpStatus: 200,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      incompleteReason: null,
      inputTokens: 500_000,
      cachedInputTokens: 100_000,
      outputTokens: 200_000,
      reasoningOutputTokens: 0,
      totalTokens: 700_000,
      upstreamCreatedAt: 1_785_640_800,
      upstreamCompletedAt: 1_785_640_801,
      // 请求时间晚于基线源更新时间，用于覆盖“无快照时按当前基线重算”的分支；
      // 23:30 UTC 处于 Off-Peak 时段。
      requestStartedAtMs: Date.parse("2026-08-17T23:30:00.000Z"),
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      recordedAtMs: nowMs - 1,
      weeklyQuota: null,
    });
    store.record({
      provider: "ocg-main",
      pricing: {
        billingMode: "subscription",
        currency: "USD",
        source: "opencode-go-official",
        effectiveAtMs: 1_785_000_000_000,
        uncachedInputPricePerMillionNanos: 140_000_000,
        cachedInputPricePerMillionNanos: 2_800_000,
        outputPricePerMillionNanos: 280_000_000,
      },
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-2",
      turnId: "turn-2",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      reasoningEffort: "high",
      status: "completed",
      httpStatus: 200,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      incompleteReason: null,
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 10_000,
      reasoningOutputTokens: 0,
      totalTokens: 110_000,
      upstreamCreatedAt: 1_785_640_800,
      upstreamCompletedAt: 1_785_640_801,
      // 请求开始于月度窗口内、但早于基线源更新时间，
      // 用于覆盖“快照存在时按快照重新计价”的分支。
      requestStartedAtMs: Date.parse("2026-08-16T15:00:00.000Z"),
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      recordedAtMs: nowMs - 1,
      weeklyQuota: null,
    });
    store.record({
      provider: "ocg-main",
      pricing: {
        billingMode: "subscription",
        currency: "USD",
        source: "opencode-go-official",
        effectiveAtMs: 1_785_000_000_000,
        uncachedInputPricePerMillionNanos: 440_000_000,
        cachedInputPricePerMillionNanos: 14_000_000,
        outputPricePerMillionNanos: 1_320_000_000,
      },
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-3",
      turnId: "turn-3",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      reasoningEffort: "high",
      status: "completed",
      httpStatus: 200,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      incompleteReason: null,
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 50_000,
      reasoningOutputTokens: 0,
      totalTokens: 150_000,
      upstreamCreatedAt: 1_785_640_800,
      upstreamCompletedAt: 1_785_640_801,
      requestStartedAtMs: Date.parse("2026-08-16T08:00:00.000Z"),
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      recordedAtMs: nowMs - 1,
      weeklyQuota: null,
    });
    store.close();

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        monthly: {
          status: "ok",
          percent: 1,
          resetsAt: "2026-08-20T00:00:00.000Z",
        },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => nowMs,
    });

    const usage = await adapter.accountUsage();
    expect(usage.kind).toBe("quota-windows");
    if (usage.kind !== "quota-windows") {
      throw new Error("unexpected usage kind");
    }
    expect(usage.modelUsage).toHaveLength(2);
    const offPeak = usage.modelUsage!.find(
      (estimate) => estimate.bucket === "off-peak",
    );
    const peak = usage.modelUsage!.find(
      (estimate) => estimate.bucket === "peak",
    );
    if (
      offPeak === undefined
      || peak === undefined
      || offPeak.usedUsdNanos === null
      || peak.usedUsdNanos === null
    ) {
      throw new Error("expected both OpenCode Go pricing buckets");
    }
    expect(offPeak).toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "off-peak",
      includedUsageUsd: 30,
      windowEndAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
    });
    expect(offPeak.usedUsdNanos).toBeGreaterThan(0);
    expect(offPeak.remainingUsdNanos).toBe(
      30_000_000_000 - offPeak.usedUsdNanos,
    );
    expect(offPeak!.usedPercent).toBeCloseTo(
      offPeak.usedUsdNanos / 30_000_000_000 * 100,
      6,
    );
    expect(peak).toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "peak",
      includedUsageUsd: 30,
      windowEndAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
    });
    expect(peak.usedUsdNanos).toBeGreaterThan(0);
    expect(peak.remainingUsdNanos).toBe(
      30_000_000_000 - peak.usedUsdNanos,
    );
    expect(peak!.usedPercent).toBeCloseTo(
      peak.usedUsdNanos / 30_000_000_000 * 100,
      6,
    );
    expect(offPeak!.windowStartAtMs).toBe(
      opencodeGoMonthlyWindowStartMs(Date.parse("2026-08-20T00:00:00.000Z") / 1_000),
    );
  });

  it("reports local token totals for each quota window from the metrics database", async () => {
    const codexHome = await createCodexHome();
    const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-window-tokens-"));
    temporaryDirectories.push(directory);
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    const baseMs = Date.parse("2026-08-17T14:00:00.000Z");
    const hourMs = 60 * 60 * 1_000;
    const dayMs = 24 * hourMs;
    recordWindowSample(store, baseMs - 1 * hourMs, 60_000, 40_000, 100_000, baseMs - 1 * hourMs);
    recordWindowSample(store, baseMs - 4 * hourMs, 60_000, 40_000, null, baseMs - 4 * hourMs);
    recordWindowSample(store, baseMs - 6 * hourMs, 10_000, 10_000, 20_000, baseMs - 6 * hourMs);
    recordWindowSample(store, baseMs - 6 * dayMs, 20_000, 10_000, 30_000, baseMs - 6 * dayMs);
    recordWindowSample(store, baseMs - 20 * dayMs, 5_000, 5_000, 10_000, baseMs - 20 * dayMs);
    store.record({
      provider: "deepseek",
      pricing: null,
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-other",
      turnId: "turn-other",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      reasoningEffort: "high",
      status: "completed",
      httpStatus: 200,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      incompleteReason: null,
      inputTokens: 9_000_000,
      cachedInputTokens: 0,
      outputTokens: 9_000_000,
      reasoningOutputTokens: 0,
      totalTokens: 18_000_000,
      upstreamCreatedAt: 0,
      upstreamCompletedAt: 0,
      requestStartedAtMs: baseMs - 1 * hourMs,
      firstTokenAtMs: null,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: null,
      lastOutputDeltaAtMs: null,
      responseCompletedAtMs: baseMs - 1 * hourMs,
      weeklyQuota: null,
    });
    store.close();

    const nowMs = baseMs;
    const rollingResetsAt = new Date(baseMs + 30 * 60 * 1_000).toISOString();
    const weeklyResetsAt = new Date(baseMs + 12 * hourMs).toISOString();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 45, resetsAt: rollingResetsAt },
        weekly: { status: "ok", percent: 18, resetsAt: weeklyResetsAt },
        monthly: { status: "ok", percent: 15, resetsAt: "2026-09-15T10:22:00.000Z" },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => nowMs,
    });

    const usage = await adapter.accountUsage();
    expect(usage.kind).toBe("quota-windows");
    if (usage.kind !== "quota-windows") {
      throw new Error("unexpected usage kind");
    }
    const byWindow = new Map(
      usage.windows.map((window) => [window.windowId, window.localTokens]),
    );
    expect(byWindow.get("rolling")).toBe(200_000);
    expect(byWindow.get("weekly")).toBe(250_000);
    expect(byWindow.get("monthly")).toBe(220_000);
  });

  it("falls back to fixed rolling windows when the official reset time is missing", async () => {
    const codexHome = await createCodexHome();
    const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-window-fallback-"));
    temporaryDirectories.push(directory);
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    const baseMs = Date.parse("2026-08-17T14:00:00.000Z");
    const hourMs = 60 * 60 * 1_000;
    const dayMs = 24 * hourMs;
    recordWindowSample(store, baseMs - 1 * hourMs, 60_000, 40_000, 100_000, baseMs - 1 * hourMs);
    recordWindowSample(store, baseMs - 4 * hourMs, 60_000, 40_000, null, baseMs - 4 * hourMs);
    recordWindowSample(store, baseMs - 6 * hourMs, 10_000, 10_000, 20_000, baseMs - 6 * hourMs);
    recordWindowSample(store, baseMs - 6 * dayMs, 20_000, 10_000, 30_000, baseMs - 6 * dayMs);
    store.close();

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 45 },
        weekly: { status: "ok", percent: 18 },
        monthly: { status: "ok", percent: 15, resetsAt: "2026-09-15T10:22:00.000Z" },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => baseMs,
    });

    const usage = await adapter.accountUsage();
    expect(usage.kind).toBe("quota-windows");
    if (usage.kind !== "quota-windows") {
      throw new Error("unexpected usage kind");
    }
    const byWindow = new Map(
      usage.windows.map((window) => [window.windowId, window.localTokens]),
    );
    expect(byWindow.get("rolling")).toBe(200_000);
    expect(byWindow.get("weekly")).toBe(250_000);
    expect(byWindow.get("monthly")).toBe(220_000);
  });

  it("attributes tokens by the recorded quota window snapshot when present", async () => {
    const codexHome = await createCodexHome();
    const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-window-snapshot-"));
    temporaryDirectories.push(directory);
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    const baseMs = Date.parse("2026-08-17T14:00:00.000Z");
    const hourMs = 60 * 60 * 1_000;
    const dayMs = 24 * hourMs;
    const rollingResetsAt = Math.floor((baseMs + 30 * 60 * 1_000) / 1_000);
    const weeklyResetsAt = Math.floor((baseMs + 12 * hourMs) / 1_000);
    const monthlyResetsAt = Math.floor(Date.parse("2026-09-15T10:22:00.000Z") / 1_000);
    const currentWindows = [
      { windowId: "rolling", resetsAt: rollingResetsAt },
      { windowId: "weekly", resetsAt: weeklyResetsAt },
      { windowId: "monthly", resetsAt: monthlyResetsAt },
    ];
    // 请求时间在滚动窗口范围外，但快照属于当前窗口：按快照归属。
    recordWindowSample(
      store,
      baseMs - 6 * hourMs,
      60_000,
      40_000,
      100_000,
      baseMs,
      currentWindows,
    );
    // 请求时间在当前滚动窗口范围内，但快照属于上一个窗口：按快照排除。
    recordWindowSample(
      store,
      baseMs - 1 * hourMs,
      60_000,
      40_000,
      100_000,
      baseMs,
      [
        { windowId: "rolling", resetsAt: rollingResetsAt - 5 * hourMs / 1_000 },
        { windowId: "weekly", resetsAt: weeklyResetsAt },
        { windowId: "monthly", resetsAt: monthlyResetsAt },
      ],
    );
    // 周窗口同理：旧快照排除、匹配快照计入。
    recordWindowSample(
      store,
      baseMs - 7 * dayMs,
      10_000,
      10_000,
      20_000,
      baseMs,
      [
        { windowId: "rolling", resetsAt: rollingResetsAt - 5 * hourMs / 1_000 },
        { windowId: "weekly", resetsAt: weeklyResetsAt },
        { windowId: "monthly", resetsAt: monthlyResetsAt },
      ],
    );
    // 请求时间在当前周窗口范围内，但快照属于上一周：按快照排除。
    recordWindowSample(
      store,
      baseMs - 6 * dayMs,
      10_000,
      10_000,
      20_000,
      baseMs,
      [
        { windowId: "rolling", resetsAt: rollingResetsAt - 5 * hourMs / 1_000 },
        { windowId: "weekly", resetsAt: weeklyResetsAt - 7 * dayMs / 1_000 },
        { windowId: "monthly", resetsAt: monthlyResetsAt },
      ],
    );
    // 月度快照匹配的请求计入月度窗口，即使请求时间早于倒推起点之外也不受影响。
    recordWindowSample(
      store,
      baseMs - 40 * dayMs,
      5_000,
      5_000,
      10_000,
      baseMs,
      [
        { windowId: "rolling", resetsAt: rollingResetsAt - 5 * hourMs / 1_000 },
        { windowId: "weekly", resetsAt: weeklyResetsAt - 7 * dayMs / 1_000 },
        { windowId: "monthly", resetsAt: monthlyResetsAt },
      ],
    );
    store.close();

    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: {
          status: "ok",
          percent: 45,
          resetsAt: new Date(baseMs + 30 * 60 * 1_000).toISOString(),
        },
        weekly: {
          status: "ok",
          percent: 18,
          resetsAt: new Date(baseMs + 12 * hourMs).toISOString(),
        },
        monthly: {
          status: "ok",
          percent: 15,
          resetsAt: "2026-09-15T10:22:00.000Z",
        },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => baseMs + 1,
    });

    const usage = await adapter.accountUsage();
    expect(usage.kind).toBe("quota-windows");
    if (usage.kind !== "quota-windows") {
      throw new Error("unexpected usage kind");
    }
    const byWindow = new Map(
      usage.windows.map((window) => [window.windowId, window.localTokens]),
    );
    expect(byWindow.get("rolling")).toBe(100_000);
    expect(byWindow.get("weekly")).toBe(220_000);
    expect(byWindow.get("monthly")).toBe(250_000);
  });

  it("back-calculates the monthly window start from the reset time", () => {
    expect(opencodeGoMonthlyWindowStartMs(
      Date.parse("2026-09-15T14:22:07.934Z") / 1_000,
    )).toBe(Date.parse("2026-08-15T14:22:07.934Z"));
    expect(opencodeGoMonthlyWindowStartMs(
      Date.parse("2026-03-31T00:00:00.000Z") / 1_000,
    )).toBe(Date.parse("2026-02-28T00:00:00.000Z"));
    expect(() => opencodeGoMonthlyWindowStartMs(Number.NaN))
      .toThrow("月度窗口重置时间无效");
  });

  it("exposes a remaining usage reader that matches the requested model", async () => {
    const codexHome = await createCodexHome();
    const reader = createOpencodeGoRemainingUsageReader({
      environment: testEnvironment(codexHome),
      fetchImpl: async () => new Response(JSON.stringify({
        usage: {
          monthly: {
            status: "ok",
            percent: 1,
            resetsAt: "2026-08-20T00:00:00.000Z",
          },
        },
      }), { status: 200 }),
    });

    await expect(reader("deepseek-v4-flash")).resolves.toBeNull();
    await expect(reader("deepseek-v4-pro")).resolves.toBeNull();
  });

  it("picks the OpenCode Go peak or off-peak bucket matching the current time", async () => {
    const codexHome = await createCodexHome();
    const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-reader-"));
    temporaryDirectories.push(directory);
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    recordWindowSample(
      store,
      Date.parse("2026-08-22T04:59:59.000Z"),
      100_000,
      10_000,
      110_000,
      Date.parse("2026-08-22T05:00:00.000Z"),
    );
    store.record({
      provider: "ocg-main",
      pricing: {
        billingMode: "subscription",
        currency: "USD",
        source: "opencode-go-official",
        effectiveAtMs: 1_785_000_000_000,
        uncachedInputPricePerMillionNanos: 440_000_000,
        cachedInputPricePerMillionNanos: 14_000_000,
        outputPricePerMillionNanos: 1_320_000_000,
      },
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-peak",
      turnId: "turn-peak",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      reasoningEffort: "high",
      status: "completed",
      httpStatus: 200,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      incompleteReason: null,
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 50_000,
      reasoningOutputTokens: 0,
      totalTokens: 150_000,
      upstreamCreatedAt: 1_785_640_800,
      upstreamCompletedAt: 1_785_640_801,
      requestStartedAtMs: Date.parse("2026-08-16T08:00:00.000Z"),
      recordedAtMs: Date.parse("2026-08-17T07:00:00.000Z"),
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      weeklyQuota: null,
    });
    store.close();

    const fetchImpl = async () => new Response(JSON.stringify({
      usage: {
        monthly: {
          status: "ok",
          percent: 1,
          resetsAt: "2026-08-24T00:00:00.000Z",
        },
      },
    }), { status: 200 });
    const peakReader = createOpencodeGoRemainingUsageReader({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => Date.parse("2026-08-22T02:30:00.000Z"),
    });
    const offPeakReader = createOpencodeGoRemainingUsageReader({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => Date.parse("2026-08-22T05:30:00.000Z"),
    });

    await expect(peakReader("deepseek-v4-flash")).resolves.toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "peak",
      usedUsdNanos: 110_000_000,
    });
    await expect(offPeakReader("deepseek-v4-flash")).resolves.toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "off-peak",
      usedUsdNanos: 28_600_000,
    });
    // 传入请求开始时间优先于当前时间：当前处于 Off-Peak，但请求开始于 Peak 时段。
    await expect(offPeakReader(
      "deepseek-v4-flash",
      Date.parse("2026-08-22T02:30:00.000Z"),
    )).resolves.toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "peak",
      usedUsdNanos: 110_000_000,
    });
  });

  it("prefers the stored pricing bucket over the current baseline for historical requests", async () => {
    const codexHome = await createCodexHome();
    const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-stored-bucket-"));
    temporaryDirectories.push(directory);
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    store.record({
      provider: "ocg-main",
      pricing: {
        billingMode: "subscription",
        currency: "USD",
        source: "opencode-go-official",
        effectiveAtMs: 1_785_000_000_000,
        bucket: "off-peak",
        uncachedInputPricePerMillionNanos: 440_000_000,
        cachedInputPricePerMillionNanos: 14_000_000,
        outputPricePerMillionNanos: 1_320_000_000,
      },
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-stored",
      turnId: "turn-stored",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      reasoningEffort: "high",
      status: "completed",
      httpStatus: 200,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      incompleteReason: null,
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 10_000,
      reasoningOutputTokens: 0,
      totalTokens: 110_000,
      upstreamCreatedAt: 1_785_640_800,
      upstreamCompletedAt: 1_785_640_801,
      requestStartedAtMs: Date.parse("2026-08-22T08:00:00.000Z"),
      recordedAtMs: Date.parse("2026-08-22T09:00:00.000Z"),
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      weeklyQuota: null,
    });
    store.close();

    const nowMs = Date.parse("2026-08-23T08:30:00.000Z");
    const fetchImpl = async () => new Response(JSON.stringify({
      usage: {
        monthly: {
          status: "ok",
          percent: 1,
          resetsAt: "2026-08-24T00:00:00.000Z",
        },
      },
    }), { status: 200 });
    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => nowMs,
    });

    const usage = await adapter.accountUsage();
    expect(usage.kind).toBe("quota-windows");
    if (usage.kind !== "quota-windows") {
      throw new Error("unexpected usage kind");
    }
    const offPeak = usage.modelUsage?.find(
      (estimate) => estimate.bucket === "off-peak",
    );
    const peak = usage.modelUsage?.find(
      (estimate) => estimate.bucket === "peak",
    );
    // 请求晚于当前价格基线生效时间且开始于 Peak 时段，但快照保存的是 Off-Peak 档位：
    // 历史重算应沿用存档位，并使用当前基线的 Off-Peak 单价。
    expect(offPeak).toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "off-peak",
      usedUsdNanos: 28_600_000,
    });
    expect(peak).toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "peak",
      usedUsdNanos: 0,
    });
  });

  it("excludes requests started before the monthly window from usage estimates", async () => {
    const codexHome = await createCodexHome();
    const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-window-boundary-"));
    temporaryDirectories.push(directory);
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    store.record({
      provider: "ocg-main",
      pricing: {
        billingMode: "subscription",
        currency: "USD",
        source: "opencode-go-official",
        effectiveAtMs: 1_785_000_000_000,
        bucket: "peak",
        uncachedInputPricePerMillionNanos: 440_000_000,
        cachedInputPricePerMillionNanos: 14_000_000,
        outputPricePerMillionNanos: 1_320_000_000,
      },
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-window-boundary",
      turnId: "turn-window-boundary",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      reasoningEffort: "high",
      status: "completed",
      httpStatus: 200,
      errorType: null,
      errorCode: null,
      errorMessage: null,
      incompleteReason: null,
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 10_000,
      reasoningOutputTokens: 0,
      totalTokens: 110_000,
      upstreamCreatedAt: 1_785_640_800,
      upstreamCompletedAt: 1_785_640_801,
      // 请求开始于月度窗口（2026-07-20）之前，仅入库时间落在窗口内。
      requestStartedAtMs: Date.parse("2026-07-19T12:00:00.000Z"),
      recordedAtMs: Date.parse("2026-08-17T07:00:00.000Z"),
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      weeklyQuota: null,
    });
    store.close();

    const adapter = createOpencodeGoAccountAdapter({
      environment: testEnvironment(codexHome),
      fetchImpl: async () => new Response(JSON.stringify({
        usage: {
          monthly: {
            status: "ok",
            percent: 1,
            resetsAt: "2026-08-20T00:00:00.000Z",
          },
        },
      }), { status: 200 }),
      metricsDatabasePath: metricsPath,
      nowMs: () => Date.parse("2026-08-17T08:30:00.000Z"),
    });

    const usage = await adapter.accountUsage();
    expect(usage.kind).toBe("quota-windows");
    if (usage.kind !== "quota-windows") {
      throw new Error("unexpected usage kind");
    }
    expect(usage.modelUsage).toEqual([]);
  });

  it("does not report OpenCode Go remaining usage for other providers", async () => {
    const codexHome = await createCodexHome();
    const fetchImpl = vi.fn();
    const reader = createOpencodeGoRemainingUsageReader({
      environment: testEnvironment(codexHome),
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(reader(
      "deepseek-v4-flash",
      Date.parse("2026-08-17T08:30:00.000Z"),
      "deepseek",
    )).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

async function createCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-account-"));
  temporaryDirectories.push(directory);
  const providerDirectory = join(
    directory,
    ".codex-connect",
    "providers",
    "opencode-go",
  );
  await mkdir(providerDirectory, { recursive: true, mode: 0o700 });
  const accountDirectory = join(providerDirectory, "accounts", "main");
  await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "config.toml"), 'model = "gpt-5.6-sol"\n', { mode: 0o600 });
  await writeFile(
    join(directory, "sf-ocg-main.config.toml"),
    `model = "deepseek-v4-flash"\nmodel_provider = "ocg-main"\n${providerConfig("sk-test-secret")}`,
    { mode: 0o600 },
  );
  await writeFile(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([{ id: "main", default: true, email: "user@example.com" }], null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(accountDirectory, "managed.toml"),
    'version = 1\nprovider = "ocg-main"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  return directory;
}

async function createAccountRegistryCodexHome(): Promise<string> {
  return createCodexHome();
}

async function createAccountRegistry(
  codexHome: string,
  mode: "switching" | "exclusive",
): Promise<void> {
  const providerDirectory = join(
    codexHome,
    ".codex-connect",
    "providers",
    "opencode-go",
  );
  const accountDirectory = join(providerDirectory, "accounts", "main");
  await mkdir(accountDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([{ id: "main", default: true, email: "user@example.com" }], null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(accountDirectory, "managed.toml"),
    `version = 1\nprovider = "ocg-main"\nmode = "${mode}"\n`,
    { mode: 0o600 },
  );
}

function testEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: codexHome,
    CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
  };
}

function providerConfig(apiKey: string): string {
  return `[model_providers.ocg-main]\nname = "ocg-main"\nbase_url = "https://opencode.ai/zen/go/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nexperimental_bearer_token = "${apiKey}"\n`;
}

function recordWindowSample(
  store: SqliteModelRequestMetricsStore,
  requestStartedAtMs: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number | null,
  recordedAtMs?: number,
  quotaWindows?: ReadonlyArray<{ windowId: string; resetsAt: number | null }> | null,
): void {
  store.record({
    provider: "ocg-main",
    pricing: null,
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-window",
    turnId: "turn-window",
    model: "deepseek-v4-flash",
    serviceTier: "default",
    reasoningEffort: "high",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens,
    upstreamCreatedAt: 0,
    upstreamCompletedAt: 0,
    requestStartedAtMs,
    firstTokenAtMs: null,
    firstReasoningDeltaAtMs: null,
    lastReasoningDeltaAtMs: null,
    firstOutputDeltaAtMs: null,
    lastOutputDeltaAtMs: null,
    responseCompletedAtMs: requestStartedAtMs,
    ...(recordedAtMs === undefined ? {} : { recordedAtMs }),
    weeklyQuota: null,
    quotaWindows: quotaWindows ?? null,
  });
}
