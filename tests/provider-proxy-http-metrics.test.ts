import {
  createServer,
  request as httpRequest,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetricsState, observeJsonResponse, observeResponseEvent, HttpResponseMetricsObserver, invalidateGenerationTiming, observeChatTiming } from "../src/provider-proxy/response-metrics-observer.js";
import { generationSpeed } from "../runtime/request-timing.mjs";
import { ChatGenerationTimingObserver } from "../src/provider-proxy/generation-timing.js";

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
  vi.restoreAllMocks();
  await cleanupProviderProxyTestServers(openServers);
});

describe("ProviderProxy HTTP metrics", () => {
  it.each(["sse", "websocket"] as const)("measures upstream response and complete mixed generation without a dump (%s)", format => {
    const metric = createMetricsState({ threadId: null, turnId: null, operation: "response" }, 0, format === "sse" ? "http" : "websocket", "response", null, 0);
    const http = new HttpResponseMetricsObserver(metric);
    const send = (at: number, type: string, fields: Record<string, unknown> = {}) => {
      const event = { type, ...fields };
      if (format === "sse") http.observeChunk(Buffer.from(sse(type, event)), at, at);
      else observeResponseEvent(metric, type, event, at, at);
    };
    send(393, "codex.rate_limits");
    send(1713, "response.output_item.added", { item: { id: "r", type: "reasoning" } });
    send(5276, "response.output_item.done", { item: { id: "r", type: "reasoning" } });
    send(5276, "response.output_item.added", { item: { id: "m", type: "message" } });
    send(5277, "response.output_text.delta", { item_id: "m", delta: "a" });
    send(6804, "response.output_text.delta", { item_id: "m", delta: "b" });
    send(6947, "response.output_item.done", { item: { id: "m", type: "message" } });
    send(6953, "response.output_item.added", { item: { id: "t", type: "custom_tool_call" } });
    send(6954, "response.custom_tool_call_input.delta", { item_id: "t", delta: "a" });
    send(20221, "response.custom_tool_call_input.delta", { item_id: "t", delta: "b" });
    send(20315, "response.output_item.done", { item: { id: "t", type: "custom_tool_call" } });
    send(20460, "response.completed", { response: { status: "completed", output: [], usage: { output_tokens: 813, output_tokens_details: { reasoning_tokens: 96 } } } });
    expect(metric).toMatchObject({ responseTimeMs: 393, totalDurationMs: 20460,
      generationTiming: { reasoningMs: 3563, textMs: 1527, toolMs: 13267, totalMs: 18357 } });
    expect(generationSpeed(metric)).toBeCloseTo(44.288, 2);
  });

  it.each(["single", "missing-done", "missing-part", "hidden-reasoning", "unknown-item", "failed", "backpressure"])("does not invent a generation speed for %s", failure => {
    const metric = createMetricsState({ threadId: null, turnId: null, operation: "response" }, 0, "websocket", "response", null, 0);
    const send = (at: number, type: string, fields: Record<string, unknown>) => observeResponseEvent(metric, type, { type, ...fields }, at, at);
    send(10, "response.output_item.added", { item: { id: "m", type: failure === "unknown-item" ? "image_generation_call" : "message" } });
    send(20, "response.output_text.delta", { item_id: "m", delta: "a" });
    if (failure === "backpressure") invalidateGenerationTiming(metric);
    if (failure !== "single") send(30, "response.output_text.delta", { item_id: "m", delta: "b" });
    if (failure !== "missing-done") send(40, "response.output_item.done", { item: { id: "m", type: "message",
      ...(failure === "missing-part" ? { content: [{ type: "output_text", text: "ab" }, { type: "output_text", text: "unobserved" }] } : {}) } });
    send(50, failure === "failed" ? "response.failed" : "response.completed", { response: { status: failure === "failed" ? "failed" : "completed", usage: { output_tokens: 10, output_tokens_details: { reasoning_tokens: failure === "hidden-reasoning" ? 2 : 0 } } } });
    expect(metric.generationTiming).toBeUndefined();
    expect(generationSpeed(metric)).toBeNull();
  });

  it("does not restore a blocked proxy generation interval from Chat diagnostics", () => {
    const metric = createMetricsState({ threadId: null, turnId: null, operation: "response" }, 0, "http", "response", null, 0);
    invalidateGenerationTiming(metric);
    observeChatTiming(metric, { submittedAt: 0, responseTimeMs: 10, generationTiming: { reasoningMs: 0, textMs: 20, toolMs: 0, totalMs: 20 } });
    expect(metric.responseTimeMs).toBe(10);
    expect(metric.generationTiming).toBeUndefined();
  });

  it("uses raw Chat intervals and unions parallel tools without charging waits", () => {
    const observer = new ChatGenerationTimingObserver();
    const push = (at: number, delta: unknown) => observer.push({ choices: [{ delta }] }, at);
    push(100, { reasoning_content: "a" }); push(200, { reasoning_content: "b" });
    push(500, { content: "a" }); push(600, { content: "b" });
    const tools = (argumentsValue: string) => ({ tool_calls: [0, 1].map(index => ({ index, function: { arguments: argumentsValue } })) });
    push(900, tools("{")); push(1200, tools("}"));
    expect(observer.finish(100, 20)).toEqual({ reasoningMs: 100, textMs: 100, toolMs: 300, totalMs: 500 });
  });

  it("does not turn coalesced Chat frames into a microsecond generation interval", () => {
    const observer = new ChatGenerationTimingObserver();
    observer.push({ choices: [{ delta: { content: "a" } }] }, 100);
    observer.push({ choices: [{ delta: { content: "b" } }] }, 100);
    expect(observer.finish(2, 0)).toBeUndefined();
  });

  it("retains interleaved parallel Chat tool intervals and unions their overlap", () => {
    const observer = new ChatGenerationTimingObserver();
    const push = (index: number, at: number) => observer.push({ choices: [{ delta: { tool_calls: [{ index, function: { arguments: "x" } }] } }] }, at);
    push(0, 100); push(1, 200); push(0, 300); push(1, 400);
    expect(observer.finish(10, 0)).toEqual({ reasoningMs: 0, textMs: 0, toolMs: 300, totalMs: 300 });
  });

  it("uses plaintext reasoning deltas rather than its delayed item close", () => {
    const metric = createMetricsState({ threadId: null, turnId: null, operation: "response" }, 0, "websocket", "response", null, 0);
    const send = (at: number, type: string, fields: Record<string, unknown>) => observeResponseEvent(metric, type, { type, ...fields }, at, at);
    send(10, "response.output_item.added", { item: { id: "r", type: "reasoning" } });
    send(20, "response.reasoning_text.delta", { item_id: "r", delta: "a" });
    send(40, "response.reasoning_text.delta", { item_id: "r", delta: "b" });
    send(200, "response.output_item.done", { item: { id: "r", type: "reasoning" } });
    send(220, "response.completed", { response: { status: "completed", usage: { output_tokens: 10, output_tokens_details: { reasoning_tokens: 10 } } } });
    expect(metric.generationTiming).toEqual({ reasoningMs: 20, textMs: 0, toolMs: 0, totalMs: 20 });
  });
  it.each([false, true])("handles native HTTP backpressure without changing successful delivery (%s)", async blocked => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => { void (async () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "response.output_item.added", item: { id: "m", type: "message" } },
          { type: "response.output_text.delta", item_id: "m", delta: "a".repeat(blocked ? 131072 : 1) },
          { type: "response.output_text.delta", item_id: "m", delta: "b" },
          { type: "response.output_item.done", item: { id: "m", type: "message" } },
          { type: "response.completed", response: { status: "completed", usage: { output_tokens: 2 } } },
        ];
        for (const event of events) {
          response.write(sse(event.type, event));
          await new Promise(resolve => setTimeout(resolve, 15));
        }
        response.end();
      })(); });
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    openServers.push({ close: () => new Promise<void>(resolve => upstream.close(() => resolve())) });
    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", { upstreamHost: "127.0.0.1",
      upstreamPort: (upstream.address() as AddressInfo).port, upstreamProtocol: "http", onMetrics: metric => { metrics.push(metric); } });
    await proxy.start(); openServers.push(proxy);
    const response = await fetch(`http://${proxy.address()}/responses`, { method: "POST", body: "{}" });
    expect(await response.text()).toContain("response.completed");
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.status).toBe("completed");
    expect(metrics[0]?.responseTimeMs).toBeGreaterThanOrEqual(0);
    if (blocked) expect(metrics[0]?.generationTiming).toBeUndefined();
    else expect(metrics[0]?.generationTiming?.textMs).toBeGreaterThan(0);
  });
  it("keeps header quota observation times when concurrent requests finish in reverse order", async () => {
    const responses: ServerResponse[] = [];
    const upstream = createServer((request, response) => {
      request.resume();
      const index = responses.push(response) - 1;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        ...(index < 2 ? {
          "x-codex-secondary-used-percent": String(10 + index),
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": "1786233600",
        } : {}),
      });
      response.flushHeaders();
      response.write(": ready\n\n");
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    openServers.push({ close: () => new Promise<void>(resolve => upstream.close(() => resolve())) });
    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1", upstreamPort: (upstream.address() as AddressInfo).port,
      upstreamProtocol: "http", onMetrics: metric => { metrics.push(metric); },
    });
    await proxy.start();
    openServers.push(proxy);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const begin = () => {
      let resolveHead: () => void = () => undefined;
      const head = new Promise<void>(resolve => { resolveHead = resolve; });
      const done = new Promise<void>((resolve, reject) => {
        const request = httpRequest({ hostname: "127.0.0.1", port: Number(proxy.address().split(":")[1]),
          path: "/responses", method: "POST" }, response => {
          resolveHead();
          response.resume();
          response.on("end", resolve);
          response.on("error", reject);
        });
        request.on("error", reject);
        request.end("{}");
      });
      return { head, done };
    };
    const first = begin();
    await first.head;
    clock.mockReturnValue(2_000);
    const second = begin();
    await second.head;
    const finish = (index: number, status: "completed" | "failed" = "completed") => responses[index]!.end(sse(`response.${status}`, {
      type: `response.${status}`, response: { status, usage: { input_tokens: 10, output_tokens: 1 } },
    }));
    clock.mockReturnValue(3_000);
    finish(1);
    await second.done;
    clock.mockReturnValue(4_000);
    finish(0, "failed");
    await first.done;
    expect(metrics.map(metric => [metric.weeklyQuota?.usedPercentMillionths, metric.quotaObservedAtMs, metric.responseCompletedAtMs]))
      .toEqual([[11_000_000, 2_000, 3_000], [10_000_000, 1_000, 4_000]]);
    expect(metrics[1]?.status).toBe("failed");
    clock.mockReturnValue(5_000);
    const third = begin();
    await third.head;
    clock.mockReturnValue(6_000);
    finish(2);
    await third.done;
    expect(metrics[2]).toMatchObject({ weeklyQuota: null, quotaObservedAtMs: null });
  });

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
      quotaObservedAtMs: expect.any(Number),
    })]);
  });

it.each([false, true])("attaches original window times and keeps mixed-source times unknown (%s)", async (includeWeeklyQuota) => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    const quotaClock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const observeChunk = HttpResponseMetricsObserver.prototype.observeChunk;
    vi.spyOn(HttpResponseMetricsObserver.prototype, "observeChunk").mockImplementation(function (this: HttpResponseMetricsObserver, ...args) {
      clock.mockReturnValue(900);
      return observeChunk.apply(this, args);
    });
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream", ...(includeWeeklyQuota ? {
          "x-codex-secondary-used-percent": "10",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-at": "1786233600",
        } : {}) });
        clock.mockReturnValue(350);
        response.write(sse("response.output_text.delta", {
          type: "response.output_text.delta", delta: "content",
        }));
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
      quotaWindowsProvider: async () => ({ windows: quotaWindows, observedAtMs: 1_000 }),
      resolveUpstream: async () => {
        await Promise.resolve();
        clock.mockReturnValue(300);
        return { host: "127.0.0.1", port: upstreamAddress.port, protocol: "http" };
      },
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);
    await new Promise<void>(resolve => setImmediate(resolve));
    quotaClock.mockReturnValue(2_000);

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
      request.write('{"model":"requested');
      request.end('-model"}');
    });

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      status: "completed",
      httpStatus: 200,
      model: "deepseek-v4-flash",
      requestModel: "requested-model",
      responseModel: "deepseek-v4-flash",
      quotaWindows,
      quotaObservedAtMs: includeWeeklyQuota ? null : 1_000,
    });
    expect(metrics[0]?.firstTokenMs).toBe(50);
    expect(metrics[0]?.totalDurationMs).toBeGreaterThanOrEqual(50);
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
      request.write('{"service_tier":"prio');
      request.write('rity","model":"deepseek-v4-flash","stream":true}');
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
      requestServiceTier: "priority",
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

it.each([413, 429])("closes an unfinished upload after fully forwarding upstream HTTP %s", async status => {
  let upstreamClosed = false;
  const upstream = createServer((request, response) => {
    request.socket.on("close", () => { upstreamClosed = true; });
    response.writeHead(status, { "content-type": "application/json" });
    response.write('{"error":');
    const timer = setTimeout(() => response.end('{"code":"fixture_rejected"}}'), 20);
    response.once("close", () => clearTimeout(timer));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  openServers.push({ close: async () => {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  } });
  const metrics: ProviderProxyMetrics[] = [];
  const errors: Error[] = [];
  const proxy = new ProviderProxy("127.0.0.1:0", {
    upstreamHost: "127.0.0.1", upstreamPort: (upstream.address() as AddressInfo).port,
    upstreamProtocol: "http", onMetrics: value => { metrics.push(value); }, onError: error => { errors.push(error); },
  });
  await proxy.start(); openServers.push(proxy);
  const result = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    let result: { status: number | undefined; body: string } | undefined;
    const request = httpRequest(`http://${proxy.address()}/responses`, { method: "POST" }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += String(chunk); });
      response.once("error", reject);
      response.once("end", () => { result = { status: response.statusCode, body }; });
    });
    request.once("error", reject);
    request.write("{");
    const interval = setInterval(() => request.write(" "), 10);
    const deadline = setTimeout(() => { reject(new Error("Unfinished upload was not closed")); request.destroy(); }, 1_000);
    request.once("close", () => {
      clearInterval(interval); clearTimeout(deadline);
      if (!result) { reject(new Error("Error response was truncated")); return; }
      resolve(result);
    });
  });
  expect(result).toEqual({ status, body: '{"error":{"code":"fixture_rejected"}}' });
  await vi.waitFor(() => expect(upstreamClosed).toBe(true));
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ httpStatus: status, status: "failed", errorCode: "fixture_rejected" });
  expect(errors).toEqual([]);
});


describe("per-response upstream usage amount", () => {
  it.each(["json", "sse", "websocket"] as const)("preserves exact decimals and unknown values over %s", format => {
    for (const [amount, expected] of [
      ["0", "0"], ["0.12345678901234567890", "0.12345678901234567890"],
      [undefined, null], [null, null], [0.125, null], ["", null], ["-1", null],
      ["NaN", null], ["1e2", null], [" 1 ", null], ["1\n", null], ["9".repeat(129), null],
    ]) {
      const metric = createMetricsState({ threadId: null, turnId: null, operation: "response" }, 1,
        format === "websocket" ? "websocket" : "http", "response", null);
      const response = { status: "completed", usage_metadata: { amount, metadata: { secret: "not collected" } } };
      if (format === "json") observeJsonResponse(metric, response, 2);
      else if (format === "websocket") observeResponseEvent(metric, "response.completed", { response }, 2, 2);
      else {
        metric.responseFormat = "sse";
        const observer = new HttpResponseMetricsObserver(metric);
        const bytes = Buffer.from(sse("response.completed", { type: "response.completed", response }));
        observer.observeChunk(bytes.subarray(0, 40), 2, 2);
        observer.observeChunk(bytes.subarray(40), 2, 2);
      }
      expect(metric.responseUsageAmount).toBe(expected);
      expect(metric.status).toBe("completed");
      expect(JSON.stringify(metric)).not.toContain("not collected");
    }
  });
});
