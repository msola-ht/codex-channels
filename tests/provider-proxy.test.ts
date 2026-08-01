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
      onMetrics: (metric) => metrics.push(metric),
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
      metric.firstReasoningDeltaAtMs === null
      || metric.lastReasoningDeltaAtMs === null
    ) {
      throw new Error("缺少推理流时间戳");
    }
    expect(metric.lastReasoningDeltaAtMs - metric.firstReasoningDeltaAtMs)
      .toBeGreaterThan(0);
    expect(metric.firstOutputDeltaAtMs).toBeTypeOf("number");
    expect(metric.firstResponseByteAtMs).toBeTypeOf("number");
    expect(received).toHaveLength(1);
    expect(received[0]?.host).toBe(`127.0.0.1:${upstreamAddress.port}`);
    expect(received[0]?.authorization).toBe("Bearer sk-test1234");
    expect(received[0]?.body).toContain("deepseek-v4-flash");
  });

  it("does not emit metrics when turn metadata is missing but still forwards", async () => {
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
      onMetrics: (metric) => metrics.push(metric),
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

  it("rejects a non-loopback listen address", async () => {
    const proxy = new ProviderProxy("0.0.0.0:1234", {
      upstreamHost: "api.deepseek.com",
    });

    await expect(proxy.start()).rejects.toThrow(/回环/u);
  });

  it("rejects paths other than /responses", async () => {
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
