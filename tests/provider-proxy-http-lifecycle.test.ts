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

describe("ProviderProxy HTTP lifecycle", () => {
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
    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      timeoutMs: 150,
      onError: (error) => errors.push(error),
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
      request.write(JSON.stringify({ model: "deepseek-v4-flash" }));
      request.end();
    });

    expect(status).toBe(502);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]?.message).toContain("超时");
    expect(metrics).toEqual([expect.objectContaining({
      status: "failed",
      errorType: "upstream_request_error",
    })]);
  });

it("does not wait for quota refresh before forwarding a completed response", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sse("response.completed", {
          type: "response.completed",
          response: { model: "deepseek-v4-flash", status: "completed", usage: null },
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

    let resolveQuota: (
      windows: readonly { windowId: string; resetsAt: number | null }[] | null,
    ) => void = () => undefined;
    const quota = new Promise<
      readonly { windowId: string; resetsAt: number | null }[] | null
    >((resolve) => {
      resolveQuota = resolve;
    });
    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      quotaWindowsProvider: () => quota,
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
      status: "completed",
      quotaWindows: null,
    })]);
    resolveQuota(null);
  });

it("cancels an active quota refresh when the proxy closes", async () => {
    let observedSignal: AbortSignal | undefined;
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      upstreamProtocol: "http",
      quotaWindowsProvider: (_accountId, signal) => {
        observedSignal = signal;
        if (!signal) return Promise.resolve(null);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve(null), { once: true });
        });
      },
    });
    await proxy.start();
    openServers.push(proxy);

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
    await proxy.close();
    expect(observedSignal?.aborted).toBe(true);
  });

it("does not report an expected upstream abort after a completed SSE response", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse("response.completed", {
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

    const errors: Error[] = [];
    let resolveMetric: (metric: ProviderProxyMetrics) => void = () => undefined;
    const metric = new Promise<ProviderProxyMetrics>((resolve) => {
      resolveMetric = resolve;
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      onError: (error) => errors.push(error),
      onMetrics: (value) => resolveMetric(value),
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
        response.once("data", () => {
          response.destroy();
          resolveResponse();
        });
        response.on("error", (error) => {
          if (error.message !== "aborted") rejectResponse(error);
        });
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    await expect(metric).resolves.toMatchObject({ status: "completed" });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(errors).toEqual([]);
  });

it("forwards ordinary deltas before waiting for terminal metrics", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write([
          sse("response.reasoning_text.delta", {
            type: "response.reasoning_text.delta",
            delta: "思考",
          }),
          sse("response.output_text.delta", {
            type: "response.output_text.delta",
            delta: "OK",
          }),
        ].join(""));
        setTimeout(() => response.end(
          sse("response.completed", {
            type: "response.completed",
            response: { id: "r1", usage: null },
          }),
        ), 20);
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
    let resolveVisibleOutput: () => void = () => undefined;
    const visibleOutput = new Promise<void>((resolve) => {
      resolveVisibleOutput = resolve;
    });
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
          if (responseBody.includes("OK")) resolveVisibleOutput();
        });
        response.on("end", resolveResponse);
        response.on("error", rejectResponse);
      });
      request.on("error", rejectResponse);
      request.end("{}");
    });

    await visibleOutput;
    expect(responseBody).toContain("OK");
    await metricsStarted;
    let responseCompleted = false;
    void completed.then(() => {
      responseCompleted = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(responseCompleted).toBe(false);
    acknowledgeMetrics();
    await completed;
    expect(responseBody).toContain("response.completed");
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
});
