import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  ProviderProxy,
  type ProviderProxyMetrics,
} from "../src/provider-proxy/index.js";

const openServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop()!;
    await server.close();
  }
});
describe("ProviderProxy WebSocket metrics", () => {
  it("classifies remote compaction v2 WebSocket traffic and strips private metadata", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    let upstreamMessage: Record<string, unknown> | undefined;
    let upstreamPath = "";
    let upstreamTimingHeader: string | undefined;
    upstreamWebSocket.on("connection", (socket, request) => {
      upstreamPath = request.url ?? "";
      const timingHeader = request.headers["x-responsesapi-include-timing-metrics"];
      upstreamTimingHeader = Array.isArray(timingHeader) ? timingHeader[0] : timingHeader;
      socket.on("message", (data) => {
        upstreamMessage = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        socket.send(JSON.stringify({ type: "response.created", response: { id: "r1" } }));
        socket.send(JSON.stringify({ type: "responsesapi.websocket_timing", timing_metrics: {
          response_id: "r1", timing_scope: "logical_turn", first_sampled_message_ttft_ms: 569,
        } }));
        socket.send(JSON.stringify({
          type: "codex.rate_limits",
          plan_type: "plus",
          rate_limits: {
            primary: null,
            secondary: {
              used_percent: 27.125,
              window_minutes: 10080,
              reset_at: 1786233600,
            },
          },
        }));
        socket.send(JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          delta: "thinking",
        }));
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "OK" }));
        socket.send(JSON.stringify({
          response: {
            id: "r1",
            output: [{ type: "message" }],
            usage: {
              input_tokens: 120,
              input_tokens_details: { cached_tokens: 80 },
              output_tokens: 30,
              output_tokens_details: { reasoning_tokens: 10 },
              total_tokens: 150,
            },
          },
          type: "response.completed",
        }));
      });
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
      },
    });

    const metrics: ProviderProxyMetrics[] = [];
    const requestStartedAtMs = Date.now() - 50;
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      upstreamBasePath: "/backend-api/codex",
      allowOpenAiApiPaths: true,
      requestOpenAiTimingMetrics: true,
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);

    const client = new WebSocket(`ws://${proxy.address()}/responses`, {
      headers: { "x-responsesapi-include-timing-metrics": "true" },
    });
    const completed = new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "response.create",
          reasoning: { effort: "medium" },
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              request_kind: "compaction",
              thread_id: "thread-ws",
              turn_id: "turn-ws",
            }),
            "x-codex-ws-stream-request-start-ms": String(requestStartedAtMs),
            stable: "kept",
          },
        }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as { type?: string };
        if (message.type === "response.completed") resolve();
      });
      client.on("error", reject);
    });
    await completed;
    client.close();

    expect(upstreamMessage).toEqual({
      type: "response.create",
      reasoning: { effort: "medium" },
      client_metadata: {
        "x-codex-ws-stream-request-start-ms": String(requestStartedAtMs),
        stable: "kept",
      },
    });
    expect(upstreamPath).toBe("/backend-api/codex/responses");
    expect(upstreamTimingHeader).toBe("true");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      operation: "compact",
      upstreamTtftMs: 569,
      threadId: "thread-ws",
      turnId: "turn-ws",
      reasoningEffort: "medium",
      requestStartedAtMs,
      weeklyQuota: {
        limitId: "codex",
        usedPercentMillionths: 27_125_000,
        resetsAt: 1_786_233_600,
        planType: "plus",
      },
      status: "completed",
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 150,
    });
    expect(metrics[0]).not.toHaveProperty("firstTokenAtMs");
    expect(metrics[0]?.firstContentMs).toBeGreaterThanOrEqual(0);
    expect(metrics[0]?.totalDurationMs).toBeGreaterThanOrEqual(metrics[0]!.firstContentMs!);
  });

  it("does not record WebSocket startup prewarm as a model request", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    let upstreamMessage: Record<string, unknown> | undefined;
    let upstreamTimingHeader: string | undefined;
    upstreamWebSocket.on("connection", (socket, request) => {
      const timingHeader = request.headers["x-responsesapi-include-timing-metrics"];
      upstreamTimingHeader = Array.isArray(timingHeader) ? timingHeader[0] : timingHeader;
      socket.on("message", (data) => {
        upstreamMessage = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        socket.send(JSON.stringify({
          type: "response.completed",
          response: {
            id: "warm-1",
            usage: {
              input_tokens: 12_000,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 0,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 12_000,
            },
          },
        }));
      });
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
      },
    });

    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      allowOpenAiApiPaths: true,
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);

    const client = new WebSocket(`ws://${proxy.address()}/responses`, {
      headers: { "x-responsesapi-include-timing-metrics": "true" },
    });
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "response.create",
          generate: false,
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              request_kind: "prewarm",
              thread_id: "thread-warm",
            }),
          },
        }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as { type?: string };
        if (message.type === "response.completed") resolve();
      });
      client.on("error", reject);
    });
    client.close();

    expect(upstreamMessage).toEqual({
      type: "response.create",
      generate: false,
      client_metadata: {},
    });
    expect(upstreamTimingHeader).toBeUndefined();
    expect(metrics).toEqual([]);
  });

  it("records a failed WebSocket handshake without turn metadata", async () => {
    const upstreamServer = createServer();
    upstreamServer.on("upgrade", (_request, socket) => {
      socket.write(
        "HTTP/1.1 429 Too Many Requests\r\n"
        + "Content-Type: application/json\r\n"
        + "Content-Length: 0\r\n"
        + "Connection: close\r\n\r\n",
      );
      socket.end();
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstreamServer.close(() => resolveClose());
      }),
    });

    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);

    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("等待 WebSocket 握手失败超时")),
        3_000,
      );
      client.on("close", () => {
        clearTimeout(timer);
        resolve();
      });
      client.on("error", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      transport: "websocket",
      responseFormat: "websocket",
      operation: "response",
      status: "failed",
      httpStatus: 429,
      errorType: "upstream_handshake_error",
      errorMessage: null,
      threadId: null,
      turnId: null,
    });
  });

  it("classifies a wrapped WebSocket error event as a failed metric", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    upstreamWebSocket.on("connection", (socket) => {
      socket.on("message", () => {
        socket.send(JSON.stringify({
          type: "error",
          status: 429,
          error: {
            type: "usage_limit_reached",
            code: "usage_limit_exceeded",
            message: "You've hit your usage limit.",
          },
        }));
        socket.close(1008, "usage limit");
      });
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
      },
    });

    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);

    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "response.create",
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "thread-err",
              turn_id: "turn-err",
            }),
          },
        }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as {
          type?: string;
          status?: number;
        };
        if (message.type === "error") resolve();
      });
      client.on("error", reject);
    });
    client.close();

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      transport: "websocket",
      status: "failed",
      httpStatus: 429,
      errorType: "usage_limit_reached",
      errorCode: "usage_limit_exceeded",
      errorMessage: "You've hit your usage limit.",
      threadId: "thread-err",
      turnId: "turn-err",
    });
  });

  it("classifies a WebSocket close reason as a failed metric", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    upstreamWebSocket.on("connection", (socket) => {
      socket.on("message", () => {
        socket.close(1008, "You've hit your usage limit");
      });
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
      },
    });

    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);

    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "response.create",
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
              thread_id: "thread-close",
              turn_id: "turn-close",
            }),
          },
        }));
      });
      client.on("close", () => resolve());
      client.on("error", reject);
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      transport: "websocket",
      status: "failed",
      httpStatus: null,
      errorType: "usage_limit_reached",
      errorMessage: "You've hit your usage limit",
      threadId: "thread-close",
      turnId: "turn-close",
    });
  });

  it("emits one completed metric when a WebSocket closes during delivery", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    let resolveUpstreamClosed: () => void = () => undefined;
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    upstreamWebSocket.on("connection", (socket) => {
      socket.on("close", resolveUpstreamClosed);
      socket.on("message", () => {
        socket.send(JSON.stringify({
          type: "response.completed",
          response: { model: "gpt-5.6-sol", status: "completed" },
        }), () => socket.close());
      });
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
      },
    });
    const metrics: ProviderProxyMetrics[] = [];
    const releases: Array<() => void> = [];
    let resolveFirstMetric: () => void = () => undefined;
    const firstMetric = new Promise<void>((resolve) => {
      resolveFirstMetric = resolve;
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: (metric) => {
        metrics.push(metric);
        resolveFirstMetric();
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    });
    await proxy.start();
    openServers.push(proxy);
    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    client.on("open", () => {
      client.send(JSON.stringify({
        type: "response.create",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-close",
            turn_id: "turn-close",
          }),
        },
      }));
    });

    await firstMetric;
    await upstreamClosed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    for (const release of releases) release();

    expect(metrics).toEqual([expect.objectContaining({
      status: "completed",
      model: "gpt-5.6-sol",
    })]);
    client.terminate();
  });

  it("keeps the request model when a WebSocket closes before completion", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    upstreamWebSocket.on("connection", (socket) => {
      socket.on("message", () => socket.close());
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
      },
    });

    let resolveMetric: (metric: ProviderProxyMetrics) => void = () => undefined;
    const metric = new Promise<ProviderProxyMetrics>((resolve) => {
      resolveMetric = resolve;
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: (value) => resolveMetric(value),
    });
    await proxy.start();
    openServers.push(proxy);
    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    client.on("open", () => {
      client.send(JSON.stringify({
        type: "response.create",
        model: "gpt-5.6-sol",
        service_tier: "priority",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-interrupted",
            turn_id: "turn-interrupted",
          }),
        },
      }));
    });

    await expect(metric).resolves.toMatchObject({
      status: "failed",
      errorType: "websocket_closed",
      model: "gpt-5.6-sol",
      serviceTier: "priority",
    });
    client.terminate();
  });

  it("marks a client-initiated WebSocket close as a client disconnect", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    upstreamWebSocket.on("connection", () => {
      // 保持连接打开，等待代理客户端主动关闭。
    });
    await new Promise<void>((resolveListen) => {
      upstreamServer.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await new Promise<void>((resolveClose) => upstreamServer.close(() => resolveClose()));
      },
    });

    let resolveMetric: (metric: ProviderProxyMetrics) => void = () => undefined;
    const metric = new Promise<ProviderProxyMetrics>((resolve) => {
      resolveMetric = resolve;
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: (value) => resolveMetric(value),
    });
    await proxy.start();
    openServers.push(proxy);
    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    client.on("open", () => {
      client.send(JSON.stringify({
        type: "response.create",
        client_metadata: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-client-close",
            turn_id: "turn-client-close",
          }),
        },
      }));
      setImmediate(() => client.close(1_000, "client stopped"));
    });

    await expect(metric).resolves.toMatchObject({
      status: "failed",
      errorType: "client_disconnected",
      threadId: "thread-client-close",
      turnId: "turn-client-close",
    });
  });
});
