import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toEqual({
      kind: "quota-windows",
      provider: "opencode-go",
      available: true,
      windows: [
        {
          windowId: "rolling",
          label: "5小时",
          usedPercent: 0,
          resetsAt: Math.floor(Date.parse("2026-08-16T18:03:54.934Z") / 1_000),
          status: "ok",
        },
        {
          windowId: "weekly",
          label: "7天",
          usedPercent: 2,
          resetsAt: Math.floor(Date.parse("2026-08-17T00:00:00.934Z") / 1_000),
          status: "ok",
        },
        {
          windowId: "monthly",
          label: "月度",
          usedPercent: 1,
          resetsAt: Math.floor(Date.parse("2026-09-15T14:22:07.934Z") / 1_000),
          status: "ok",
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

  it("fails with a stable user error without exposing malformed responses", async () => {
    const codexHome = await createCodexHome();
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
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
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 10, resetsAt: "2026-08-16T18:03:54.934Z" },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(adapter.accountUsage()).resolves.toMatchObject({
      kind: "quota-windows",
      provider: "opencode-go",
      available: true,
      windows: [{ windowId: "rolling", usedPercent: 10 }],
    });
  });

  it("skips invalid windows and rejects when none remain", async () => {
    const codexHome = await createCodexHome();
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
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
    const metricsPath = modelRequestMetricsDatabasePath(
      join(directory, "gateway.sqlite3"),
    );
    const store = new SqliteModelRequestMetricsStore(metricsPath);
    store.record({
      provider: "opencode-go",
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
      requestStartedAtMs: Date.parse("2026-08-16T17:00:00.000Z"),
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      weeklyQuota: null,
    });
    store.record({
      provider: "opencode-go",
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
      requestStartedAtMs: 1_000,
      firstTokenAtMs: 1_100,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: 1_400,
      lastOutputDeltaAtMs: 1_600,
      responseCompletedAtMs: 1_650,
      weeklyQuota: null,
    });
    store.record({
      provider: "opencode-go",
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
      weeklyQuota: null,
    });
    store.close();

    const nowMs = Date.now();
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
      environment: { CODEX_HOME: codexHome },
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
    expect(offPeak).toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "off-peak",
      includedUsageUsd: 15,
      usedUsdNanos: 237_500_000,
      remainingUsdNanos: 14_762_500_000,
      windowEndAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
    });
    expect(offPeak!.usedPercent).toBeCloseTo(
      237_500_000 / 15_000_000_000 * 100,
      6,
    );
    expect(peak).toMatchObject({
      model: "deepseek-v4-flash",
      bucket: "peak",
      includedUsageUsd: 15,
      usedUsdNanos: 110_000_000,
      remainingUsdNanos: 14_890_000_000,
      windowEndAtMs: Date.parse("2026-08-20T00:00:00.000Z"),
    });
    expect(peak!.usedPercent).toBeCloseTo(
      110_000_000 / 15_000_000_000 * 100,
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
    const baseMs = Date.now();
    const hourMs = 60 * 60 * 1_000;
    const dayMs = 24 * hourMs;
    recordWindowSample(store, baseMs - 1 * hourMs, 60_000, 40_000, 100_000);
    recordWindowSample(store, baseMs - 4 * hourMs, 60_000, 40_000, null);
    recordWindowSample(store, baseMs - 6 * hourMs, 10_000, 10_000, 20_000);
    recordWindowSample(store, baseMs - 6 * dayMs, 20_000, 10_000, 30_000);
    recordWindowSample(store, baseMs - 20 * dayMs, 5_000, 5_000, 10_000);
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

    const nowMs = Date.now();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      usage: {
        rolling: { status: "ok", percent: 45, resetsAt: "2026-08-17T01:23:00.000Z" },
        weekly: { status: "ok", percent: 18, resetsAt: "2026-08-23T20:00:00.000Z" },
        monthly: { status: "ok", percent: 15, resetsAt: "2026-09-15T10:22:00.000Z" },
      },
    }), { status: 200 }));
    const adapter = createOpencodeGoAccountAdapter({
      environment: { CODEX_HOME: codexHome },
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
      environment: { CODEX_HOME: codexHome },
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
      Date.parse("2026-08-16T17:00:00.000Z"),
      100_000,
      10_000,
      110_000,
    );
    store.record({
      provider: "opencode-go",
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
          resetsAt: "2026-08-20T00:00:00.000Z",
        },
      },
    }), { status: 200 });
    const peakReader = createOpencodeGoRemainingUsageReader({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => Date.parse("2026-08-17T08:30:00.000Z"),
    });
    const offPeakReader = createOpencodeGoRemainingUsageReader({
      environment: { CODEX_HOME: codexHome },
      fetchImpl: fetchImpl as typeof fetch,
      metricsDatabasePath: metricsPath,
      nowMs: () => Date.parse("2026-08-17T17:30:00.000Z"),
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
  });
});

async function createCodexHome(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "codexc-opencode-go-account-"));
  temporaryDirectories.push(directory);
  await writeFile(join(directory, "config.toml"), 'model = "gpt-5.6-sol"\n', { mode: 0o600 });
  await writeFile(
    join(directory, "sf-opencode-go.config.toml"),
    `model = "deepseek-v4-flash"\nmodel_provider = "opencode-go"\n${providerConfig("sk-test-secret")}`,
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "sf-opencode-go.managed.toml"),
    'version = 1\nprovider = "opencode-go"\n',
    { mode: 0o600 },
  );
  return directory;
}

function providerConfig(apiKey: string): string {
  return `[model_providers.opencode-go]\nname = "opencode-go"\nbase_url = "https://opencode.ai/zen/go/v1"\nwire_api = "responses"\nsupports_websockets = false\nrequires_openai_auth = false\nexperimental_bearer_token = "${apiKey}"\n`;
}

function recordWindowSample(
  store: SqliteModelRequestMetricsStore,
  requestStartedAtMs: number,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number | null,
): void {
  store.record({
    provider: "opencode-go",
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
    weeklyQuota: null,
  });
}
