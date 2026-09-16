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
    expect(forwardedMetadata).toBeUndefined();
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

it("forwards HTTP compaction requests through the configured upstream base path", async () => {
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

    expect(status).toBe(200);
    expect(receivedPath).toBe("/v1/responses/compact?mode=test");
    expect(metrics).toEqual([expect.objectContaining({
      operation: "compact",
      responseFormat: "json",
      status: "completed",
      httpStatus: 200,
    })]);
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

it("forwards the locked OpenAI 0.154.0 HTTP API paths without recording response metrics", async () => {
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
