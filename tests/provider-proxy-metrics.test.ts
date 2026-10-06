import { once } from "node:events";
import { PrivateIpcServer } from "../runtime/private-ipc.mjs";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  it.each(["reasoningEffort", "userAgent", "errorMessage", "weeklyQuota", "quotaWindows"] as const)("rejects records missing required nullable field %s", async field => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-required-metrics-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "m.sock");
    const received: ProviderProxyMetrics[] = [];
    const server = new ProviderProxyMetricsServer(socketPath, value => { received.push(value); });
    await server.start();
    try {
      const incomplete = { ...metrics() } as Partial<ProviderProxyMetrics>;
      delete incomplete[field];
      await sendProviderProxyMetrics(socketPath, incomplete as ProviderProxyMetrics);
      await sendProviderProxyMetrics(socketPath, metrics());
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(metrics());
    } finally { await server.close(); }
  });
  it("validates quota observation times and leaves missing historical times unknown", async () => {
    const directory = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "codexc-qo-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "m.sock");
    const received: ProviderProxyMetrics[] = [];
    const server = new ProviderProxyMetricsServer(socketPath, metric => { received.push(metric); });
    await server.start();
    try {
      const weeklyQuota = { limitId: "codex" as const, usedPercentMillionths: 10_000_000, resetsAt: 1_786_233_600, planType: null };
      for (const quotaObservedAtMs of [undefined, null, 0, 1_500, -1, 1.5, "1500", Number.MAX_SAFE_INTEGER + 1]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), weeklyQuota, quotaObservedAtMs } as ProviderProxyMetrics);
      }
      await sendProviderProxyMetrics(socketPath, { ...metrics(), quotaObservedAtMs: 1_500 });
      await sendProviderProxyMetrics(socketPath, { ...metrics(), quotaWindows: [], quotaObservedAtMs: 1_500 });
      await sendProviderProxyMetrics(socketPath, metrics());
      expect(received.map(metric => metric.quotaObservedAtMs)).toEqual([null, null, 0, 1_500, null]);
    } finally { await server.close(); }
  });
  it("accepts finite nonnegative TTFT and rejects malformed values at IPC", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-ttft-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    const received: ProviderProxyMetrics[] = [];
    const server = new ProviderProxyMetricsServer(socketPath, (value) => { received.push(value); });
    await server.start();
    try {
      for (const value of [0, 569.25, -1, "123", null]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), upstreamTtftMs: value } as ProviderProxyMetrics);
      }
      expect(received.map((value) => value.upstreamTtftMs)).toEqual([0, 569.25]);
      received.length = 0;
      for (const responseUsageAmount of ["0", "0.12345678901234567890", null, undefined, 1, "-1", "secret", "9".repeat(129)]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), responseUsageAmount } as ProviderProxyMetrics);
      }
      expect(received.map(value => value.responseUsageAmount)).toEqual(["0", "0.12345678901234567890", null, undefined]);
      received.length = 0;
      const diagnostics = { upstreamProvider: "deepseek", upstreamAttemptCount: 2, modelAttemptCount: 1, finishReason: "stop",
        errorStage: "stream" as const, upstreamErrorCode: "rate_limit", upstreamErrorType: "limit", upstreamHttpStatus: 429 };
      await sendProviderProxyMetrics(socketPath, { ...metrics(), ...diagnostics });
      for (const invalid of [{ upstreamProvider: "unsafe value" }, { upstreamAttemptCount: "2" }, { modelAttemptCount: -1 },
        { finishReason: "x".repeat(257) }, { errorStage: "arbitrary" }, { upstreamErrorCode: "unsafe\ncode" }, { upstreamHttpStatus: 200 }]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), ...invalid } as ProviderProxyMetrics);
      }
      expect(received).toHaveLength(1); expect(received[0]).toMatchObject(diagnostics);
      received.length = 0;
      for (const value of [0, 12.5, -1, "123", null]) {
        await sendProviderProxyMetrics(socketPath, {
          ...metrics(), timingBasis: "submitted", firstTokenMs: value, requestModel: "requested", responseModel: "echoed",
        } as ProviderProxyMetrics);
      }
      expect(received.map((value) => value.firstTokenMs)).toEqual([0, 12.5]);
      expect(received[0]).toMatchObject({ requestModel: "requested", responseModel: "echoed" });
      received.length = 0;
      for (const value of [0, 1234.5, -1, "123", null]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), timingBasis: "submitted", totalDurationMs: value } as ProviderProxyMetrics);
      }
      expect(received.map((value) => value.totalDurationMs)).toEqual([0, 1234.5]);
      received.length = 0;
      for (const legacy of [{ totalDurationMs: 1234 }, { firstContentMs: 12 }, { firstTokenMs: 12 }, { timingBasis: "entry", totalDurationMs: 12 }]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), ...legacy } as ProviderProxyMetrics);
      }
      expect(received).toHaveLength(0);
      for (const requestServiceTier of ["priority", "default", null, 123]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), requestServiceTier } as ProviderProxyMetrics);
      }
      expect(received.map((value) => value.requestServiceTier)).toEqual(["priority", "default", null]);
      received.length = 0;
      const reference = { label: "openai", session: "2026-09-19T00-00-00-000Z-2", interaction: 23 };
      for (const traffic of [reference, null, {}, { ...reference, interaction: 0 },
        { ...reference, interaction: 1.5 }, { ...reference, session: "../other" },
        { ...reference, label: "../other" }]) {
        await sendProviderProxyMetrics(socketPath, { ...metrics(), traffic } as ProviderProxyMetrics);
      }
      expect(received.map((value) => value.traffic)).toEqual([reference]);
    } finally { await server.close(); }
  });
  const unixIt = process.platform === "win32" ? it.skip : it;
  unixIt("delivers one bounded metrics record over a private Unix socket", async () => {
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

  it("normalizes malformed reasoning effort and rejects missing or overlong fields", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-effort-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    const received: ProviderProxyMetrics[] = [];
    const server = new ProviderProxyMetricsServer(socketPath, (value) => {
      received.push(value);
    });
    await server.start();

    await sendProviderProxyMetrics(socketPath, {
      ...metrics(),
      reasoningEffort: "medium",
    });
    await sendProviderProxyMetrics(socketPath, {
      ...metrics(),
      reasoningEffort: "not valid" as ProviderProxyMetrics["reasoningEffort"],
    });
    await sendProviderProxyMetrics(socketPath, {
      ...metrics(),
      reasoningEffort: "x".repeat(129),
    });
    const legacy = { ...metrics() } as Partial<ProviderProxyMetrics>;
    delete legacy.reasoningEffort;
    await sendProviderProxyMetrics(socketPath, legacy as ProviderProxyMetrics);

    expect(received.map(({ reasoningEffort }) => reasoningEffort)).toEqual([
      "medium",
      null,
    ]);
    await server.close();
  });

  it("drops metrics when the Gateway receiver is not running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-missing-"));
    temporaryDirectories.push(directory);

    await expect(sendProviderProxyMetrics(
      join(directory, "missing.sock"),
      metrics(),
    )).resolves.toBeUndefined();
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

  unixIt("cleans up when startup fails after the listener opens", async () => {
    const directory = mkdtempSync("/tmp/cm-");
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "m.sock");
    const originalStart = PrivateIpcServer.prototype.start;
    const start = vi.spyOn(PrivateIpcServer.prototype, "start").mockImplementationOnce(async function (this: PrivateIpcServer, message: string) {
      await originalStart.call(this, message);
      throw new Error("injected startup failure");
    });
    const server = new ProviderProxyMetricsServer(socketPath, () => undefined);
    try {
      await expect(server.start()).rejects.toThrow("injected startup failure");
      expect(existsSync(socketPath)).toBe(false);
      await server.start();
      expect(existsSync(socketPath)).toBe(true);
      await server.close();
      expect(existsSync(socketPath)).toBe(false);
      await expect(server.start()).rejects.toThrow("已关闭");
    } finally {
      start.mockRestore();
      await server.close();
    }
  });

  unixIt("rejects a public socket without deleting it", async () => {
    const directory = mkdtempSync("/tmp/cm-");
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "m.sock");
    const occupied = createServer();
    await new Promise<void>(resolve => occupied.listen(socketPath, resolve));
    chmodSync(socketPath, 0o666);
    const server = new ProviderProxyMetricsServer(socketPath, () => undefined);
    try {
      await expect(server.start()).rejects.toThrow(/不安全/u);
      expect(statSync(socketPath).isSocket()).toBe(true);
      expect(statSync(socketPath).mode & 0o777).toBe(0o666);
    } finally {
      await server.close();
      await new Promise<void>(resolve => occupied.close(() => resolve()));
    }
  });

  unixIt("closes unfinished connections and makes repeated close harmless", async () => {
    const directory = mkdtempSync("/tmp/cm-");
    temporaryDirectories.push(directory);
    chmodSync(directory, 0o755);
    const socketPath = join(directory, "m.sock");
    const server = new ProviderProxyMetricsServer(socketPath, () => undefined);
    await server.start();
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    const client = createConnection(socketPath);
    try {
      await once(client, "connect");
      client.write("unfinished");
      const errors: string[] = [];
      client.on("error", (error: NodeJS.ErrnoException) => errors.push(error.code ?? "unknown"));
      const closed = new Promise<void>(resolve => client.once("close", () => resolve()));
      await server.close();
      await closed;
      expect(errors.every(code => code === "ECONNRESET")).toBe(true);
      expect(existsSync(socketPath)).toBe(false);
      writeFileSync(socketPath, "replacement", { mode: 0o600 });
      await server.close();
      expect(statSync(socketPath).isFile()).toBe(true);
    } finally {
      client.destroy();
      await server.close();
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

  unixIt("reports an occupied metrics channel without treating it as the Gateway lock", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-provider-metrics-occupied-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "metrics.sock");
    const occupied = createServer();
    await new Promise<void>((resolveListen, rejectListen) => {
      occupied.once("error", rejectListen);
      occupied.listen(socketPath, resolveListen);
    });
    chmodSync(socketPath, 0o600);
    const server = new ProviderProxyMetricsServer(socketPath, () => undefined);

    try {
      await expect(server.start()).rejects.toThrow("模型代理指标 Socket 已被占用");
      await new Promise<void>(resolve => occupied.close(() => resolve()));
      await server.start();
      await server.close();
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      await server.close();
      if (occupied.listening) await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()));
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
    reasoningEffort: null,
    status: "completed",
    httpStatus: 200,
    userAgent: "codex-tui/0.154.0 (Mac OS 15.7.9; arm64) unknown (codex-tui; 0.154.0)",
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 100,
    cachedInputTokens: 80,
    outputTokens: 20,
    reasoningOutputTokens: 5,
    totalTokens: 120,
    requestStartedAtMs: 1_000,
    responseCompletedAtMs: 1_900,
    weeklyQuota: null,
    quotaWindows: null,
    quotaObservedAtMs: null,
  };
}
