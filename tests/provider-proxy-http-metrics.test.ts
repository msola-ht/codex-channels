import {
  createServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ProviderProxy,
  type ProviderProxyMetrics,
} from "../src/provider-proxy/index.js";
import {
  cleanupProviderProxyTestServers,
  type ProviderProxyTestServer,
  providerProxySse as sse,
} from "./provider-proxy-http-test-fixture.js";

const openServers: ProviderProxyTestServer[] = [];

afterEach(async () => {
  await cleanupProviderProxyTestServers(openServers);
});

describe("ProviderProxy HTTP metrics", () => {
it("does not mark an unobservable HTTP 200 response as completed", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, {
          "x-codex-primary-used-percent": "15.25",
          "x-codex-primary-window-minutes": "10080",
          "x-codex-primary-reset-at": "1786233600",
        });
        response.end();
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
      request.end("{}");
    });

    expect(status).toBe(200);
    expect(metrics).toEqual([expect.objectContaining({
      status: "incomplete",
      httpStatus: 200,
      responseFormat: "unknown",
      incompleteReason: "response_not_observed",
      model: null,
      inputTokens: null,
      outputTokens: null,
      weeklyQuota: {
        limitId: "codex",
        usedPercentMillionths: 15_250_000,
        resetsAt: 1_786_233_600,
        planType: null,
      },
    })]);
  });

it("attaches quota window snapshots from the injected provider", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse("response.completed", {
          type: "response.completed",
          response: {
            model: "deepseek-v4-flash",
            status: "completed",
            usage: {
              input_tokens: 120,
              input_tokens_details: { cached_tokens: 100 },
              output_tokens: 30,
              output_tokens_details: { reasoning_tokens: 10 },
              total_tokens: 150,
            },
          },
        }));
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
    const quotaWindows = [
      { windowId: "rolling", resetsAt: 1_785_700_000 },
      { windowId: "weekly", resetsAt: 1_785_800_000 },
      { windowId: "monthly", resetsAt: 1_790_000_000 },
    ];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      quotaWindowsProvider: async () => quotaWindows,
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
      }, (response) => {
        response.resume();
        response.on("end", () => resolveResponse());
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      status: "completed",
      httpStatus: 200,
      model: "deepseek-v4-flash",
      quotaWindows,
    });
  });

it("recognizes SSE metadata when the upstream omits Content-Type", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200);
        response.end(sse("response.completed", {
          response: {
            model: "gpt-5.6-sol",
            status: "completed",
            output: [{ type: "message" }],
            usage: {
              input_tokens: 120,
              input_tokens_details: { cached_tokens: 100 },
              output_tokens: 30,
              output_tokens_details: { reasoning_tokens: 10 },
              total_tokens: 150,
            },
          },
        }));
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
      }, (response) => {
        response.resume();
        response.on("end", resolveResponse);
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    expect(metrics).toEqual([expect.objectContaining({
      status: "completed",
      responseFormat: "sse",
      model: "gpt-5.6-sol",
      inputTokens: 120,
      cachedInputTokens: 100,
      outputTokens: 30,
      reasoningOutputTokens: 10,
    })]);
  });

it("stops parsing oversized SSE metadata lines without truncating the response", async () => {
    const oversizedEvent = sse("response.completed", {
      type: "response.completed",
      response: {
        status: "completed",
        padding: "x".repeat(1_048_576),
      },
    });
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(oversizedEvent);
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
    const body = await new Promise<string>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/responses",
        method: "POST",
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveResponse(Buffer.concat(chunks).toString("utf8")));
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    expect(body).toBe(oversizedEvent);
    expect(metrics).toEqual([expect.objectContaining({
      status: "incomplete",
      incompleteReason: "response_not_observed",
    })]);
  });

it("forwards requests with a rewritten host and records terminal usage", async () => {
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
            response: {
              id: "r1",
              model: "deepseek-v4-flash",
              service_tier: "default",
              status: "completed",
              created_at: 1_785_640_800,
              completed_at: 1_785_640_801,
              usage: {
                input_tokens: 120,
                input_tokens_details: { cached_tokens: 100 },
                output_tokens: 30,
                output_tokens_details: { reasoning_tokens: 10 },
                total_tokens: 150,
              },
            },
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
    expect(metric).toMatchObject({
      transport: "http",
      responseFormat: "sse",
      operation: "response",
      threadId: "thread-1",
      turnId: "turn-1",
      model: "deepseek-v4-flash",
      serviceTier: "default",
      status: "completed",
      httpStatus: 200,
      inputTokens: 120,
      cachedInputTokens: 100,
      outputTokens: 30,
      reasoningOutputTokens: 10,
      totalTokens: 150,
    });
    expect(metric).not.toHaveProperty("firstTokenAtMs");
    expect(received).toHaveLength(1);
    expect(received[0]?.host).toBe(`127.0.0.1:${upstreamAddress.port}`);
    expect(received[0]?.authorization).toBe("Bearer sk-test1234");
    expect(received[0]?.body).toContain("deepseek-v4-flash");
  });

it("collects bounded metadata and Usage from a non-streaming JSON response", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "response-private-id",
          model: "gpt-5.6-sol",
          service_tier: "default",
          status: "completed",
          created_at: 1_785_640_800,
          completed_at: 1_785_640_802,
          output: [{ type: "message", content: [{ text: "不得进入指标" }] }],
          usage: {
            input_tokens: 500,
            input_tokens_details: { cached_tokens: 450 },
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 20 },
            total_tokens: 550,
          },
        }));
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

    await new Promise<void>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: Number(proxy.address().split(":")[1]),
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

    expect(metrics).toEqual([expect.objectContaining({
      responseFormat: "json",
      model: "gpt-5.6-sol",
      serviceTier: "default",
      status: "completed",
      inputTokens: 500,
      cachedInputTokens: 450,
      outputTokens: 50,
      reasoningOutputTokens: 20,
      totalTokens: 550,
    })]);
    expect(JSON.stringify(metrics)).not.toContain("不得进入指标");
    expect(JSON.stringify(metrics)).not.toContain("response-private-id");
  });

it("rejects control characters in upstream metric identifiers", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          model: "gpt-5\nforged",
          service_tier: "\u001b[31mpremium",
          status: "failed",
          error: {
            type: "rate_limit\rforged",
            code: "bad\u0000code",
          },
        }));
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

    await new Promise<void>((resolveResponse, rejectResponse) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: Number(proxy.address().split(":")[1]),
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

    expect(metrics).toEqual([expect.objectContaining({
      status: "failed",
      model: null,
      serviceTier: null,
      errorType: null,
      errorCode: null,
      errorMessage: null,
    })]);
  });

it("forwards function call argument deltas without timing them", async () => {
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
    expect(metrics[0]).not.toHaveProperty("firstTokenAtMs");
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
    expect(metrics[0]?.reasoningEffort).toBeNull();
  });

it("classifies remote compaction v2 metadata on the Responses path", async () => {
    let receivedPath = "";
    const metrics: ProviderProxyMetrics[] = [];
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
      onMetrics: (metric) => {
        metrics.push(metric);
      },
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
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "compaction",
            thread_id: "thread-compact-v2",
            turn_id: "turn-compact-v2",
          }),
        },
      }, (response) => {
        response.resume();
        response.on("end", () => resolveStatus(response.statusCode ?? 0));
        response.on("error", rejectStatus);
      });
      request.on("error", rejectStatus);
      request.end("{}");
    });

    expect(status).toBe(200);
    expect(receivedPath).toBe("/v1/responses");
    expect(metrics).toEqual([expect.objectContaining({
      operation: "compact",
      threadId: "thread-compact-v2",
      turnId: "turn-compact-v2",
      responseFormat: "json",
      status: "completed",
      httpStatus: 200,
    })]);
  });
});
