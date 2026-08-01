import {
  Agent,
  createServer,
  request as httpRequest,
} from "node:http";
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

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

describe("ProviderProxy", () => {
  it("uses the configured upstream agent", async () => {
    let agentUsed = false;
    const agent = new Agent();
    const createAgentConnection = agent.createConnection.bind(agent);
    agent.createConnection = (options, callback) => {
      agentUsed = true;
      return createAgentConnection(options, callback);
    };
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("ok"));
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamAgent: agent,
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
    } as ConstructorParameters<typeof ProviderProxy>[1]);
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    await new Promise<void>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
      }, (response) => {
        response.resume();
        response.on("end", resolveResponse);
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    expect(agentUsed).toBe(true);
  });

  it("streams the request body upstream before the client finishes sending", async () => {
    let resolveFirstChunk: () => void = () => undefined;
    const firstChunk = new Promise<void>((resolve) => {
      resolveFirstChunk = resolve;
    });
    const upstream = createServer((request, response) => {
      request.once("data", () => resolveFirstChunk());
      request.on("end", () => response.end("ok"));
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    let resolveResponse: () => void = () => undefined;
    let rejectResponse: (error: Error) => void = () => undefined;
    const completed = new Promise<void>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const request = httpRequest({
      hostname: "127.0.0.1",
      port: proxyPort,
      path: "/responses",
      method: "POST",
    }, (response) => {
      response.resume();
      response.on("end", resolveResponse);
      response.on("error", rejectResponse);
    });
    request.on("error", rejectResponse);
    request.write('{"input":"');

    let timeout: NodeJS.Timeout | undefined;
    try {
      await expect(Promise.race([
        firstChunk,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("上游未及时收到流式请求正文")),
            1_000,
          );
        }),
      ])).resolves.toBeUndefined();
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
    request.end('hello"}');
    await completed;
  });

  it("preserves upstream status and headers without forwarding local turn metadata", async () => {
    let forwardedMetadata: string | undefined;
    const upstream = createServer((request, response) => {
      forwardedMetadata = request.headers["x-codex-turn-metadata"] as string | undefined;
      request.resume();
      request.on("end", () => {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "17",
        });
        response.end(JSON.stringify({ error: { type: "rate_limit" } }));
      });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });

    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    const result = await new Promise<{
      body: string;
      contentType: string | undefined;
      retryAfter: string | undefined;
      status: number;
    }>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-private",
            turn_id: "turn-private",
          }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveResponse({
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: response.headers["content-type"],
          retryAfter: response.headers["retry-after"],
          status: response.statusCode ?? 0,
        }));
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    expect(result).toEqual({
      body: JSON.stringify({ error: { type: "rate_limit" } }),
      contentType: "application/json",
      retryAfter: "17",
      status: 429,
    });
    expect(forwardedMetadata).toBeUndefined();
  });

  it("forwards requests with a rewritten host and records reasoning/output timing", async () => {
    const received: Array<{
      host: string;
      authorization: string;
      body: string;
    }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          host: String(request.headers.host ?? ""),
          authorization: String(request.headers.authorization ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse("response.created", {
          id: "r1",
          type: "response.created",
        }));
        response.write(sse("response.reasoning_text.delta", {
          type: "response.reasoning_text.delta",
          delta: "思考1",
        }));
        setTimeout(() => {
          response.write(sse("response.reasoning_text.delta", {
            type: "response.reasoning_text.delta",
            delta: "思考2",
          }));
          response.write(sse("response.output_text.delta", {
            type: "response.output_text.delta",
            delta: "OK",
          }));
          response.write(sse("response.completed", {
            type: "response.completed",
            response: { id: "r1", usage: null },
          }));
          response.end();
        }, 30);
      });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
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

    const proxyPort = Number(proxy.address().split(":")[1]);
    const responseBody = await new Promise<string>((resolveBody, rejectBody) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer sk-test1234",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-1",
            turn_id: "turn-1",
          }),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolveBody(Buffer.concat(chunks).toString("utf8"));
        });
        response.on("error", rejectBody);
      });
      request.on("error", rejectBody);
      request.write(JSON.stringify({ model: "deepseek-v4-flash", stream: true }));
      request.end();
    });

    expect(responseBody).toContain("思考1");
    expect(responseBody).toContain("OK");
    expect(metrics).toHaveLength(1);
    const metric = metrics[0]!;
    expect(metric.threadId).toBe("thread-1");
    expect(metric.turnId).toBe("turn-1");
    if (
      metric.firstTokenAtMs === null
      || metric.firstReasoningDeltaAtMs === null
      || metric.lastReasoningDeltaAtMs === null
      || metric.firstOutputDeltaAtMs === null
      || metric.lastOutputDeltaAtMs === null
    ) {
      throw new Error("缺少模型流时间戳");
    }
    expect(metric.firstTokenAtMs).toBe(metric.firstReasoningDeltaAtMs);
    expect(metric.lastReasoningDeltaAtMs - metric.firstReasoningDeltaAtMs)
      .toBeGreaterThan(0);
    expect(metric.lastOutputDeltaAtMs).toBe(metric.firstOutputDeltaAtMs);
    expect(metric.responseCompletedAtMs).toBeGreaterThanOrEqual(
      metric.lastOutputDeltaAtMs,
    );
    expect(received).toHaveLength(1);
    expect(received[0]?.host).toBe(`127.0.0.1:${upstreamAddress.port}`);
    expect(received[0]?.authorization).toBe("Bearer sk-test1234");
    expect(received[0]?.body).toContain("deepseek-v4-flash");
  });

  it("records function call argument deltas as model output timing", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          sse("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            delta: '{"path":',
          }),
          sse("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            delta: '"README.md"}',
          }),
          sse("response.completed", {
            type: "response.completed",
            response: { id: "r-function", usage: null },
          }),
        ].join(""));
      });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
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

    const proxyPort = Number(proxy.address().split(":")[1]);
    await new Promise<void>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-function",
            turn_id: "turn-function",
          }),
        },
      }, (response) => {
        response.resume();
        response.on("end", resolveResponse);
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      threadId: "thread-function",
      turnId: "turn-function",
    });
    expect(metrics[0]?.firstTokenAtMs).not.toBeNull();
    expect(metrics[0]?.firstOutputDeltaAtMs).not.toBeNull();
    expect(metrics[0]?.lastOutputDeltaAtMs).not.toBeNull();
  });

  it("waits for reasoning metrics before forwarding the first visible output", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          sse("response.reasoning_text.delta", {
            type: "response.reasoning_text.delta",
            delta: "思考",
          }),
          sse("response.output_text.delta", {
            type: "response.output_text.delta",
            delta: "OK",
          }),
          sse("response.completed", {
            type: "response.completed",
            response: { id: "r1", usage: null },
          }),
        ].join(""));
      });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });

    let acknowledgeMetrics: () => void = () => undefined;
    const metricsAcknowledged = new Promise<void>((resolve) => {
      acknowledgeMetrics = resolve;
    });
    let resolveMetricsStarted: () => void = () => undefined;
    const metricsStarted = new Promise<void>((resolve) => {
      resolveMetricsStarted = resolve;
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: async () => {
        resolveMetricsStarted();
        await metricsAcknowledged;
      },
    });
    await proxy.start();
    openServers.push(proxy);

    let responseBody = "";
    const proxyPort = Number(proxy.address().split(":")[1]);
    const completed = new Promise<void>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-ordered",
            turn_id: "turn-ordered",
          }),
        },
      }, (response) => {
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf8");
        });
        response.on("end", resolveResponse);
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    await metricsStarted;
    let responseCompleted = false;
    void completed.then(() => {
      responseCompleted = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(responseBody).toBe("");
    expect(responseCompleted).toBe(false);
    acknowledgeMetrics();
    await completed;
    expect(responseBody).toContain("OK");
  });

  it("waits for reasoning metrics before forwarding a completion without visible text", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          sse("response.reasoning_text.delta", {
            type: "response.reasoning_text.delta",
            delta: "思考",
          }),
          sse("response.completed", {
            type: "response.completed",
            response: { id: "r1", usage: null },
          }),
        ].join(""));
      });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });

    let acknowledgeMetrics: () => void = () => undefined;
    const metricsAcknowledged = new Promise<void>((resolve) => {
      acknowledgeMetrics = resolve;
    });
    let resolveMetricsStarted: () => void = () => undefined;
    const metricsStarted = new Promise<void>((resolve) => {
      resolveMetricsStarted = resolve;
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onMetrics: async () => {
        resolveMetricsStarted();
        await metricsAcknowledged;
      },
    });
    await proxy.start();
    openServers.push(proxy);

    let responseBody = "";
    const proxyPort = Number(proxy.address().split(":")[1]);
    const completed = new Promise<void>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "thread-completed",
            turn_id: "turn-completed",
          }),
        },
      }, (response) => {
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf8");
        });
        response.on("end", resolveResponse);
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    await metricsStarted;
    let responseCompleted = false;
    void completed.then(() => {
      responseCompleted = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(responseBody).toBe("");
    expect(responseCompleted).toBe(false);
    acknowledgeMetrics();
    await completed;
    expect(responseBody).toContain("response.completed");
  });

  it("forwards and emits safely discardable metrics when turn metadata is missing", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse("response.created", { type: "response.created" }));
      response.end();
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
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

    const proxyPort = Number(proxy.address().split(":")[1]);
    await new Promise<void>((resolveBody, rejectBody) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
      }, (response) => {
        response.resume();
        response.on("end", () => resolveBody());
        response.on("error", rejectBody);
      });
      request.on("error", rejectBody);
      request.end();
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.threadId).toBeNull();
    expect(metrics[0]?.turnId).toBeNull();
  });

  it("proxies Responses WebSocket traffic and strips private turn metadata", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    let upstreamMessage: Record<string, unknown> | undefined;
    let upstreamPath = "";
    upstreamWebSocket.on("connection", (socket, request) => {
      upstreamPath = request.url ?? "";
      socket.on("message", (data) => {
        upstreamMessage = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
        socket.send(JSON.stringify({
          type: "response.reasoning_summary_text.delta",
          delta: "thinking",
        }));
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "OK" }));
        socket.send(JSON.stringify({ type: "response.completed", response: { id: "r1" } }));
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
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);

    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    const completed = new Promise<void>((resolve, reject) => {
      client.on("open", () => {
        client.send(JSON.stringify({
          type: "response.create",
          client_metadata: {
            "x-codex-turn-metadata": JSON.stringify({
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
      client_metadata: {
        "x-codex-ws-stream-request-start-ms": String(requestStartedAtMs),
        stable: "kept",
      },
    });
    expect(upstreamPath).toBe("/backend-api/codex/responses");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      threadId: "thread-ws",
      turnId: "turn-ws",
      requestStartedAtMs,
    });
    expect(metrics[0]?.firstTokenAtMs).not.toBeNull();
    expect(metrics[0]?.firstReasoningDeltaAtMs).not.toBeNull();
    expect(metrics[0]?.firstOutputDeltaAtMs).not.toBeNull();
  });

  it("rejects a non-loopback listen address", async () => {
    const proxy = new ProviderProxy("0.0.0.0:1234", {
      upstreamHost: "api.deepseek.com",
    });

    await expect(proxy.start()).rejects.toThrow(/回环/u);
  });

  it("forwards HTTP compaction requests through the configured upstream base path", async () => {
    let receivedPath = "";
    const upstream = createServer((request, response) => {
      receivedPath = request.url ?? "";
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"output":[]}');
      });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      upstreamBasePath: "/v1/",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses/compact?mode=test",
        method: "POST",
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
        response.on("error", rejectStatus);
      });
      request.on("error", rejectStatus);
      request.end("{}");
    });

    expect(status).toBe(200);
    expect(receivedPath).toBe("/v1/responses/compact?mode=test");
  });

  it("forwards the Codex model catalog request through the configured upstream base path", async () => {
    let receivedMethod = "";
    let receivedPath = "";
    const upstream = createServer((request, response) => {
      receivedMethod = request.method ?? "";
      receivedPath = request.url ?? "";
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"models":[]}');
      });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", resolveListen);
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      upstreamBasePath: "/backend-api/codex/",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    const result = await new Promise<{ body: string; status: number }>((resolve, reject) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/models?client_version=0.146.0",
        method: "GET",
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
        }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end();
    });

    expect(result).toEqual({ body: '{"models":[]}', status: 200 });
    expect(receivedMethod).toBe("GET");
    expect(receivedPath).toBe("/backend-api/codex/models?client_version=0.146.0");
  });

  it("rejects unsupported paths", async () => {
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      upstreamProtocol: "http",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/user/balance",
        method: "GET",
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
        response.on("error", rejectStatus);
      });
      request.on("error", rejectStatus);
      request.end();
    });

    expect(status).toBe(404);
  });

  it("rejects non-read-only model catalog requests", async () => {
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      upstreamProtocol: "http",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/models",
        method: "POST",
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
        response.on("error", rejectStatus);
      });
      request.on("error", rejectStatus);
      request.end();
    });

    expect(status).toBe(404);
  });

  it("does not treat a path prefix as the Responses endpoint", async () => {
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      upstreamProtocol: "http",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses-private",
        method: "POST",
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
        response.on("error", rejectStatus);
      });
      request.on("error", rejectStatus);
      request.end();
    });

    expect(status).toBe(404);
  });

  it("fails a request when the upstream stalls", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
    });
    await new Promise<void>((resolveListen) => {
      upstream.listen(0, "127.0.0.1", () => resolveListen());
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push({
      close: () => new Promise<void>((resolveClose) => {
        upstream.close(() => resolveClose());
      }),
    });

    const errors: Error[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      timeoutMs: 150,
      onError: (error) => errors.push(error),
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    const status = await new Promise<number>((resolveStatus, rejectStatus) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
        response.on("error", rejectStatus);
      });
      request.on("error", rejectStatus);
      request.write(JSON.stringify({ model: "deepseek-v4-flash" }));
      request.end();
    });

    expect(status).toBe(502);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("超时");
  });
});
