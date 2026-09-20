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
import {
  cleanupProviderProxyTestServers,
  type ProviderProxyTestServer,
  requestProviderProxy as requestProxy,
} from "./provider-proxy-http-test-fixture.js";

const openServers: ProviderProxyTestServer[] = [];

afterEach(async () => {
  await cleanupProviderProxyTestServers(openServers);
});

describe("ProviderProxy HTTP routing", () => {
  it("preserves account and compaction metadata on route failure without counting model listings", async () => {
    const samples: Array<{ sample: ProviderProxyMetrics; account: string | undefined }> = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1", accountIds: ["test"],
      resolveUpstream: async () => { throw new Error("route unavailable"); },
      onMetrics: (sample, account) => { samples.push({ sample, account }); },
    });
    await proxy.start();
    openServers.push(proxy);
    const response = await fetch(`http://${proxy.address()}/go/test/responses`, {
      method: "POST", body: "{}",
      headers: { "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-test", turn_id: "turn-test", request_kind: "compaction" }) },
    });
    await response.text();
    expect(response.status).toBe(502);
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({ account: "test", sample: {
      threadId: "thread-test", turnId: "turn-test", operation: "compact",
      status: "failed", errorType: "provider_proxy_route_error", httpStatus: 502,
    } });
    const listing = await fetch(`http://${proxy.address()}/go/test/models`);
    await listing.text();
    expect(listing.status).toBe(502);
    expect(samples).toHaveLength(1);
  });
  it("waits for an asynchronous route without losing HTTP bodies or WebSocket messages", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const routesReady = new Promise<void>((resolve) => { ready = resolve; });
    let routeCalls = 0;
    let body = "";
    const upstream = createServer((request, response) => {
      request.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      request.on("end", () => response.end("ok"));
    });
    const websocket = new WebSocketServer({ server: upstream });
    websocket.on("connection", (client) => client.on("message", (data) => client.send(data)));
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    openServers.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) });
    openServers.push({ close: () => new Promise<void>((resolve) => websocket.close(() => resolve())) });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      resolveUpstream: async () => {
        if (++routeCalls === 2) ready();
        await gate;
        return { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port, protocol: "http" };
      },
    });
    await proxy.start();
    openServers.push(proxy);
    const httpResponse = requestProxy(Number(proxy.address().split(":")[1]), "/responses", "POST");
    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    const message = new Promise<string>((resolve, reject) => {
      client.on("error", reject);
      client.on("open", () => client.send("hello"));
      client.on("message", (data) => { resolve(data.toString()); client.close(); });
    });
    await routesReady;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(body).toBe("");
    release();
    await expect(httpResponse).resolves.toEqual({ status: 200 });
    await expect(message).resolves.toBe("hello");
    expect(body).toBe("{}");
  });

  it.each([
    ["http", "shutdown", false], ["websocket", "shutdown", false],
    ["http", "disconnect", false], ["websocket", "disconnect", false],
    ["http", "shutdown", true], ["websocket", "shutdown", true],
    ["http", "disconnect", true], ["websocket", "disconnect", true],
  ] as const)("does not forward pending %s routing after %s (reject=%s)", async (transport, action, rejectRoute) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const routeReady = new Promise<void>((resolve) => { ready = resolve; });
    let upstreamRequests = 0;
    const samples: ProviderProxyMetrics[] = [];
    const upstream = createServer((_request, response) => { upstreamRequests += 1; response.end(); });
    upstream.on("upgrade", (_request, socket) => { upstreamRequests += 1; socket.destroy(); });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    openServers.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      resolveUpstream: async () => {
        ready();
        await gate;
        if (rejectRoute) throw new Error("route failed after cancellation");
        return { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port, protocol: "http" };
      },
      onMetrics: (sample) => { samples.push(sample); },
    });
    await proxy.start();
    openServers.push(proxy);
    let disconnect!: () => void;
    const closed = new Promise<void>((resolve) => {
      if (transport === "http") {
        const client = httpRequest(`http://${proxy.address()}/responses`, { method: "POST" });
        client.on("error", () => undefined);
        client.on("close", () => resolve());
        client.end("{}");
        disconnect = () => client.destroy();
      } else {
        const client = new WebSocket(`ws://${proxy.address()}/responses`);
        client.on("error", () => undefined);
        client.on("close", () => resolve());
        disconnect = () => client.terminate();
      }
    });
    await routeReady;
    if (action === "shutdown") await proxy.close();
    else disconnect();
    await closed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(upstreamRequests).toBe(0);
    if (action === "shutdown") expect(samples).toHaveLength(0);
    else {
      // 客户端 close 不代表服务端已处理断连；竞态中可观测到一次失败，但不能重复投递。
      expect(samples.length).toBeLessThanOrEqual(1);
      for (const sample of samples) expect(sample.status).toBe("failed");
    }
  });

  it.each([false, true])("isolates route failures and recovers (async=%s)", async (asynchronous) => {
    const failure = new Error("invalid proxy route");
    const errors: Error[] = [];
    const metrics: ProviderProxyMetrics[] = [];
    let failing = true;
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("ok"));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    openServers.push({ close: () => new Promise<void>((resolve) => upstream.close(() => resolve())) });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      resolveUpstream: () => {
        if (failing) {
          if (asynchronous) return Promise.reject(failure);
          throw failure;
        }
        const target = { host: "127.0.0.1", port: (upstream.address() as AddressInfo).port,
          protocol: "http" as const, basePath: "" };
        return asynchronous ? Promise.resolve(target) : target;
      },
      onError: (error) => errors.push(error),
      onMetrics: (sample) => { metrics.push(sample); },
    });
    await proxy.start();
    openServers.push(proxy);
    const port = Number(proxy.address().split(":")[1]);
    await expect(requestProxy(port, "/responses", "POST")).rejects.toThrow("502");
    await new Promise<void>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${port}/responses`);
      client.on("error", (error) => {
        if (error.message.includes("502")) resolve();
        else reject(error);
      });
      client.on("open", () => { client.close(); reject(new Error("unexpected upgrade")); });
    });
    expect(errors).toEqual([failure, failure]);
    expect(metrics).toHaveLength(2);
    expect(metrics.map((sample) => sample.transport)).toEqual(["http", "websocket"]);
    for (const sample of metrics) {
      expect(sample).toMatchObject({ status: "failed", httpStatus: 502,
        errorType: "provider_proxy_route_error", model: null, inputTokens: null });
      expect(sample.firstContentMs).toBeUndefined();
    }
    failing = false;
    await expect(requestProxy(port, "/responses", "POST")).resolves.toEqual({ status: 200 });
  });

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

it("routes /go/<account> prefixes to the shared upstream and reports the account", async () => {
    const seenPaths: string[] = [];
    const upstream = createServer((request, response) => {
      seenPaths.push(request.url ?? "");
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
    const metricsAccounts: Array<string | undefined> = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      upstreamBasePath: "/zen/go/v1",
      accountIds: ["main", "b"],
      defaultAccountId: "main",
      onMetrics: (_metrics, accountId) => {
        metricsAccounts.push(accountId);
      },
    });
    await proxy.start();
    openServers.push(proxy);
    const proxyPort = Number(proxy.address().split(":")[1]);

    await requestProxy(proxyPort, "/go/b/responses", "POST");
    await requestProxy(proxyPort, "/responses", "POST");
    await expect(requestProxy(proxyPort, "/go/unknown/responses", "POST"))
      .rejects.toMatchObject({ status: 404 });

    expect(seenPaths).toEqual([
      "/zen/go/v1/responses",
      "/zen/go/v1/responses",
    ]);
    expect(metricsAccounts).toEqual(["b", "main"]);
  });

it("attributes configured reasoning effort only to the private external-role route", async () => {
    const seenPaths: string[] = [];
    const upstream = createServer((request, response) => {
      seenPaths.push(request.url ?? "");
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
    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      externalRoleReasoningEffort: "high",
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();
    openServers.push(proxy);
    const proxyPort = Number(proxy.address().split(":")[1]);

    await requestProxy(proxyPort, "/role/external/responses", "POST");
    await requestProxy(proxyPort, "/responses", "POST");

    expect(seenPaths).toEqual(["/responses", "/responses"]);
    expect(metrics.map(({ reasoningEffort }) => reasoningEffort)).toEqual([
      "high",
      null,
    ]);
  });

it("preserves upstream status, headers and local turn metadata", async () => {
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
    expect(JSON.parse(forwardedMetadata ?? "null")).toEqual({
      thread_id: "thread-private",
      turn_id: "turn-private",
    });
    expect(metrics).toEqual([expect.objectContaining({
      status: "failed",
      httpStatus: 429,
      errorType: "rate_limit",
    })]);
  });

it("rejects a non-loopback listen address", async () => {
    const proxy = new ProviderProxy("0.0.0.0:1234", {
      upstreamHost: "api.deepseek.com",
    });

    await expect(proxy.start()).rejects.toThrow(/回环/u);
  });

it("rejects the retired HTTP compaction endpoint without forwarding or recording metrics", async () => {
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

    expect(status).toBe(404);
    expect(receivedPath).toBe("");
    expect(metrics).toEqual([]);
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

it("forwards the locked OpenAI HTTP API paths without recording response metrics", async () => {
    const received: Array<{ method: string; path: string }> = [];
    const upstream = createServer((request, response) => {
      received.push({
        method: request.method ?? "",
        path: request.url ?? "",
      });
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
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
      upstreamBasePath: "/v1",
      allowOpenAiApiPaths: true,
      onMetrics: (item) => {
        metrics.push(item);
      },
    });
    await proxy.start();
    openServers.push(proxy);
    const proxyPort = Number(proxy.address().split(":")[1]);

    for (const path of [
      "/alpha/search?source=codex",
      "/memories/trace_summarize",
      "/images/generations",
      "/images/edits",
      "/realtime/calls?intent=quicksilver",
      "/live",
    ]) {
      await requestProxy(proxyPort, path, "POST");
    }
    await expect(requestProxy(proxyPort, "/alpha/search", "GET"))
      .rejects.toMatchObject({ status: 404 });
    await expect(requestProxy(proxyPort, "/alpha/search/private", "POST"))
      .rejects.toMatchObject({ status: 404 });

    expect(received).toEqual([
      { method: "POST", path: "/v1/alpha/search?source=codex" },
      { method: "POST", path: "/v1/memories/trace_summarize" },
      { method: "POST", path: "/v1/images/generations" },
      { method: "POST", path: "/v1/images/edits" },
      { method: "POST", path: "/v1/realtime/calls?intent=quicksilver" },
      { method: "POST", path: "/v1/live" },
    ]);
    expect(metrics).toEqual([]);
  });

it("keeps OpenAI-only API paths closed for third-party provider proxies", async () => {
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: 1,
      upstreamProtocol: "http",
    });
    await proxy.start();
    openServers.push(proxy);

    const proxyPort = Number(proxy.address().split(":")[1]);
    await expect(requestProxy(proxyPort, "/alpha/search", "POST"))
      .rejects.toMatchObject({ status: 404 });
  });

it("transparently forwards official OpenAI realtime WebSockets without response metrics", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    let upstreamPath = "";
    upstreamWebSocket.on("connection", (socket, request) => {
      upstreamPath = request.url ?? "";
      socket.on("message", (data, isBinary) => socket.send(data, { binary: isBinary }));
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
      upstreamBasePath: "/v1",
      allowOpenAiApiPaths: true,
      onMetrics: (item) => {
        metrics.push(item);
      },
    });
    await proxy.start();
    openServers.push(proxy);

    const client = new WebSocket(
      `ws://${proxy.address()}/v1/realtime?call_id=rtc_test`,
    );
    await new Promise<void>((resolve, reject) => {
      client.on("open", () => client.send("ping"));
      client.on("message", (data) => {
        if (data.toString() === "ping") resolve();
      });
      client.on("error", reject);
    });
    client.close();

    expect(upstreamPath).toBe("/v1/realtime?call_id=rtc_test");
    expect(metrics).toEqual([]);
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
});
