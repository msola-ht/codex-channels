import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:net";

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
  };
}
