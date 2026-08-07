import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MetricsSync,
  type MetricsSyncConfig,
  type MetricsSyncOptions,
} from "../src/observability/index.js";
import type {
  ModelRequestMetricsStore,
  StoredModelRequestMetric,
  StoredSubagentThreadRecord,
} from "../src/observability/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("MetricsSync", () => {
  it("上传批量指标与子代理记录，并持久化推进水位", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-sync-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "metrics-sync-state.json");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const store = createStore({
      rows: [storedRow(1), storedRow(2)],
      subagents: [{
        threadId: "sub-1",
        parentThreadId: "main-1",
        agentPath: "ds",
        recordedAtMs: 1_000,
      }],
    });
    const sync = new MetricsSync(createOptions({
      config: {
        enabled: true,
        endpoint: "https://metrics.example.com/ingest",
        deviceToken: "secret-token",
        batchSize: 200,
        intervalSeconds: 1,
      },
      statePath,
      store,
      fetchImpl,
    }));

    sync.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://metrics.example.com/ingest");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret-token",
      },
    });
    const payload = JSON.parse(String((init as RequestInit).body)) as {
      deviceId: string;
      requestMetrics: Array<{ localId: number; errorMessage?: unknown }>;
      subagentThreads: unknown[];
    };
    expect(payload.deviceId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(payload.requestMetrics.map((row) => row.localId)).toEqual([1, 2]);
    expect(payload.requestMetrics[0]).not.toHaveProperty("errorMessage");
    expect(payload.requestMetrics[0]).not.toHaveProperty("id");
    expect(payload.subagentThreads).toEqual([{
      threadId: "sub-1",
      parentThreadId: "main-1",
      agentPath: "ds",
      recordedAtMs: 1_000,
    }]);

    await vi.waitFor(() => expect(existsSync(statePath)).toBe(true));
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      deviceId: string;
      lastRequestLocalId: number;
      lastSubagentRecordedAtMs: number;
    };
    expect(persisted.deviceId).toBe(payload.deviceId);
    expect(persisted.lastRequestLocalId).toBe(2);
    expect(persisted.lastSubagentRecordedAtMs).toBe(1_000);
    await sync.close();
  });

  it("没有新数据时不发起请求", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-sync-"));
    temporaryDirectories.push(directory);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const sync = new MetricsSync(createOptions({
      config: enabledConfig(),
      statePath: join(directory, "metrics-sync-state.json"),
      store: createStore(),
      fetchImpl,
    }));

    sync.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(fetchImpl).not.toHaveBeenCalled();
    await sync.close();
  });

  it("失败时不推进水位，退避后重试成功再推进", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-sync-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "metrics-sync-state.json");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));
    const store = createStore({ rows: [storedRow(1)] });
    const sync = new MetricsSync(createOptions({
      config: enabledConfig(),
      statePath,
      store,
      fetchImpl,
    }));

    sync.start();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(statePath)).toBe(false);

    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2), { timeout: 5_000 });
    await vi.waitFor(() => expect(existsSync(statePath)).toBe(true), { timeout: 5_000 });
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      lastRequestLocalId: number;
    };
    expect(persisted.lastRequestLocalId).toBe(1);
    await sync.close();
  });

  it("配置了 device_id 时使用配置值，否则复用已持久化的设备标识", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-sync-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "metrics-sync-state.json");
    const firstFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const first = new MetricsSync(createOptions({
      config: {
        ...enabledConfig(),
        deviceId: "device-a",
      },
      statePath,
      store: createStore({ rows: [storedRow(1)] }),
      fetchImpl: firstFetch,
    }));
    first.start();
    await vi.waitFor(() => expect(firstFetch).toHaveBeenCalledTimes(1));
    await first.close();

    const secondFetch = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const second = new MetricsSync(createOptions({
      config: enabledConfig(),
      statePath,
      store: createStore({ rows: [storedRow(2)] }),
      fetchImpl: secondFetch,
    }));
    second.start();
    await vi.waitFor(() => expect(secondFetch).toHaveBeenCalledTimes(1));
    expect(secondFetch).toHaveBeenCalledTimes(1);
    const [, init] = secondFetch.mock.calls[0]!;
    const payload = JSON.parse(String((init as RequestInit).body)) as {
      deviceId: string;
    };
    expect(payload.deviceId).toBe("device-a");
    await second.close();
  });
});

function createOptions(options: {
  config: MetricsSyncConfig;
  statePath: string;
  store: ModelRequestMetricsStore;
  fetchImpl: typeof fetch;
}): MetricsSyncOptions {
  return {
    ...options,
    logger: pino({ level: "silent" }),
  };
}

function enabledConfig(): MetricsSyncConfig {
  return {
    enabled: true,
    endpoint: "https://metrics.example.com/ingest",
    deviceToken: "secret-token",
    batchSize: 200,
    intervalSeconds: 1,
  };
}

function createStore(options: {
  rows?: StoredModelRequestMetric[];
  subagents?: StoredSubagentThreadRecord[];
} = {}): ModelRequestMetricsStore {
  const rows = options.rows ?? [];
  const subagents = options.subagents ?? [];
  return {
    record: vi.fn(),
    recordSubagentThread: vi.fn(),
    requestRowsAfter: vi.fn(() => rows),
    subagentThreadsAfter: vi.fn(() => subagents),
    recent: vi.fn(() => []),
    aggregate: vi.fn(() => ({
      dimension: "global" as const,
      startAtMs: 0,
      endAtMs: 1,
      aggregate: null,
      groups: [],
      totalGroupCount: 0,
    })),
    errors: vi.fn(() => ({
      startAtMs: 0,
      endAtMs: 1,
      requestCount: 0,
      unsuccessfulRequestCount: 0,
      groups: [],
      totalGroupCount: 0,
    })),
    count: vi.fn(() => rows.length),
    close: vi.fn(),
  };
}

function storedRow(id: number): StoredModelRequestMetric {
  return {
    id,
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
    errorMessage: "不应上传的原始错误",
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
    recordedAtMs: 1_700,
    requestDurationMs: 650,
    ttftMs: 100,
    thinkingDurationMs: 200,
    outputDurationMs: 200,
    generationDurationMs: 250,
    completionGapMs: 50,
    upstreamDurationMs: 1,
    uncachedInputTokens: 100,
    nonReasoningOutputTokens: 60,
    cacheHitRate: 0.9,
    thinkingTokensPerSecond: 200,
    outputTokensPerSecond: 300,
    generationTokensPerSecond: 240,
    uncachedInputCostNanos: 1,
    cachedInputCostNanos: 2,
    outputCostNanos: 3,
    totalCostNanos: 6,
    weeklyQuota: null,
  };
}
