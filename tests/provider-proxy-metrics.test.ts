import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderProxyMetricsServer,
  sendProviderProxyMetrics,
  type ProviderProxyMetrics,
} from "../src/provider-proxy/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Provider proxy metrics channel", () => {
  it("delivers one bounded metrics record over a private Unix socket", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    let resolveMetrics: (metrics: ProviderProxyMetrics) => void = () => undefined;
    const received = new Promise<ProviderProxyMetrics>((resolve) => {
      resolveMetrics = resolve;
    });
    const server = new ProviderProxyMetricsServer(socketPath, resolveMetrics);
    await server.start();
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    const delivered = sendProviderProxyMetrics(socketPath, metrics());

    await expect(received).resolves.toEqual(metrics());
    await expect(delivered).resolves.toBeUndefined();
    await server.close();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("drops metrics when the Gateway receiver is not running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-missing-"));
    temporaryDirectories.push(directory);

    await expect(sendProviderProxyMetrics(
      join(directory, "missing.sock"),
      metrics(),
    )).resolves.toBeUndefined();
  });

  it("accepts rolling-upgrade metrics without a weekly quota snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-legacy-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    let resolveMetrics: (metrics: ProviderProxyMetrics) => void = () => undefined;
    const received = new Promise<ProviderProxyMetrics>((resolve) => {
      resolveMetrics = resolve;
    });
    const server = new ProviderProxyMetricsServer(socketPath, resolveMetrics);
    await server.start();
    const legacy = { ...metrics() } as Partial<ProviderProxyMetrics>;
    delete legacy.weeklyQuota;

    await sendProviderProxyMetrics(socketPath, legacy as ProviderProxyMetrics);

    await expect(received).resolves.toMatchObject({ weeklyQuota: null });
    await server.close();
  });

  it("forwards quota window snapshots and tolerates their absence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-mq-windows-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    let resolveMetrics: (metrics: ProviderProxyMetrics) => void = () => undefined;
    const received = new Promise<ProviderProxyMetrics>((resolve) => {
      resolveMetrics = resolve;
    });
    const server = new ProviderProxyMetricsServer(socketPath, resolveMetrics);
    await server.start();
    const withWindows = {
      ...metrics(),
      quotaWindows: [
        { windowId: "rolling", resetsAt: 1_785_700_000 },
        { windowId: "weekly", resetsAt: 1_785_800_000 },
        { windowId: "monthly", resetsAt: 1_790_000_000 },
      ],
    };

    await sendProviderProxyMetrics(socketPath, withWindows);

    await expect(received).resolves.toEqual(withWindows);
    await server.close();
  });

  it("accepts legacy metrics without a quota window snapshot", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-mq-legacy-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    let resolveMetrics: (metrics: ProviderProxyMetrics) => void = () => undefined;
    const received = new Promise<ProviderProxyMetrics>((resolve) => {
      resolveMetrics = resolve;
    });
    const server = new ProviderProxyMetricsServer(socketPath, resolveMetrics);
    await server.start();
    const legacy = { ...metrics() } as Partial<ProviderProxyMetrics>;
    delete legacy.quotaWindows;

    await sendProviderProxyMetrics(socketPath, legacy as ProviderProxyMetrics);

    await expect(received).resolves.toMatchObject({ quotaWindows: null });
    await server.close();
  });

  it("closes an active listener even when startup did not reach the started state", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-cleanup-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    const server = new ProviderProxyMetricsServer(socketPath, () => undefined);
    const rawServer = (server as unknown as { server: Server }).server;
    await new Promise<void>((resolveListen) => rawServer.listen(socketPath, resolveListen));

    try {
      await server.close();
      expect(rawServer.listening).toBe(false);
    } finally {
      if (rawServer.listening) {
        await new Promise<void>((resolveClose) => rawServer.close(() => resolveClose()));
      }
    }
  });

  it("refuses to replace a non-Socket path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-unsafe-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    writeFileSync(socketPath, "not a socket", { mode: 0o600 });
    const server = new ProviderProxyMetricsServer(socketPath, () => undefined);

    await expect(server.start()).rejects.toThrow(/不安全/u);
    expect(statSync(socketPath).isFile()).toBe(true);
  });

  it("reports an occupied metrics channel without treating it as the Gateway lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-occupied-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    const occupied = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      occupied.once("error", rejectListen);
      occupied.listen(socketPath, resolveListen);
    });
    const server = new ProviderProxyMetricsServer(socketPath, () => undefined);

    try {
      await expect(server.start()).rejects.toThrow("模型代理指标 Socket 已被占用");
    } finally {
      await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
    }
  });
});

function metrics(): ProviderProxyMetrics {
  return {
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-1",
    turnId: "turn-1",
    model: "deepseek-v4-flash",
    serviceTier: null,
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    upstreamCreatedAt: 1_785_640_800,
    upstreamCompletedAt: 1_785_640_801,
    requestStartedAtMs: 1_000,
    firstTokenAtMs: 1_200,
    firstReasoningDeltaAtMs: 1_200,
    lastReasoningDeltaAtMs: 1_500,
    firstOutputDeltaAtMs: 1_600,
    lastOutputDeltaAtMs: 1_800,
    responseCompletedAtMs: 1_900,
    weeklyQuota: null,
    quotaWindows: null,
  };
}
