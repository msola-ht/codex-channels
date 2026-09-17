import {
  createServer,
  request as httpRequest,
} from "node:http";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

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
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await cleanupProviderProxyTestServers(openServers);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ProviderProxy traffic dump", () => {
  it("records the full request and response while keeping metrics intact", async () => {
    const responseBody = sse("response.output_text.delta", { delta: "OK" })
      + sse("response.completed", { response: { id: "r1" } });
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(responseBody);
      });
    });
    await listen(upstream);
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push(closeServer(upstream));
    const directory = trafficDumpDirectory();
    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      trafficDump: { directory, label: "openai" },
      onMetrics: (metric) => {
        metrics.push(metric);
      },
    });
    await proxy.start();

    const requestBody = JSON.stringify({ model: "gpt-test", input: "hello" });
    const status = await postResponses(proxy.address(), requestBody);
    await proxy.close();

    expect(status).toBe(200);
    expect(metrics).toEqual([expect.objectContaining({
      status: "completed",
      httpStatus: 200,
      responseFormat: "sse",
    })]);
    const records = readDumpRecords(directory);
    expect(records.find((record) => record.kind === "request_head")).toMatchObject({
      method: "POST",
      path: "/responses",
      headers: {
        authorization: "Bearer <redacted>",
        "content-type": "application/json",
      },
    });
    expect(records.find((record) => record.kind === "request_end"))
      .toMatchObject({ bytes: Buffer.byteLength(requestBody) });
    expect(bodyText(records, "request_body")).toBe(requestBody);
    expect(records.find((record) => record.kind === "response_head"))
      .toMatchObject({ status: 200, headers: { "content-type": "text/event-stream" } });
    expect(bodyText(records, "response_body")).toBe(responseBody);
    expect(records.find((record) => record.kind === "response_end"))
      .toMatchObject({ bytes: Buffer.byteLength(responseBody) });
    expect(readDumpContent(directory)).not.toContain("sk-secret");
    expect(statSync(directory).mode & 0o077).toBe(0);
    expect(statSync(dumpFile(directory)).mode & 0o077).toBe(0);
  });

  it("splits request bodies that exceed the per-record payload limit", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("ok"));
    });
    await listen(upstream);
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push(closeServer(upstream));
    const directory = trafficDumpDirectory();
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      trafficDump: { directory, label: "openai" },
    });
    await proxy.start();

    const requestBody = "a".repeat(2_500_000);
    expect(await postResponses(proxy.address(), requestBody)).toBe(200);
    await proxy.close();

    const records = readDumpRecords(directory);
    const parts = records.filter((record) => record.kind === "request_body");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((record) => record.part)).toEqual(
      parts.map((_record, index) => index + 1),
    );
    expect(bodyText(records, "request_body")).toBe(requestBody);
  });

  it("keeps the partial response when the client disconnects mid-stream", async () => {
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(sse("response.output_text.delta", { delta: "partial" }));
      });
    });
    await listen(upstream);
    const upstreamAddress = upstream.address() as AddressInfo;
    openServers.push(closeServer(upstream));
    const directory = trafficDumpDirectory();
    let resolveFailed: () => void = () => undefined;
    const failed = new Promise<void>((resolve) => {
      resolveFailed = resolve;
    });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      trafficDump: { directory, label: "openai" },
      onMetrics: (metric) => {
        if (metric.status === "failed") resolveFailed();
      },
    });
    await proxy.start();

    await new Promise<void>((resolveAbort) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        port: Number(proxy.address().split(":")[1]),
        path: "/responses",
        method: "POST",
      }, (response) => {
        response.once("data", () => {
          response.destroy();
          resolveAbort();
        });
        response.on("error", () => resolveAbort());
      });
      request.on("error", () => resolveAbort());
      request.end("{}");
    });
    await failed;
    await proxy.close();

    const records = readDumpRecords(directory);
    expect(bodyText(records, "response_body"))
      .toBe(sse("response.output_text.delta", { delta: "partial" }));
    expect(records.filter((record) => record.kind === "error").at(-1))
      .toMatchObject({ scope: "client_disconnected" });
  });

  it("records the WebSocket handshake and frames in both directions", async () => {
    const upstreamServer = createServer();
    const upstreamWebSocket = new WebSocketServer({ server: upstreamServer });
    let upstreamPath = "";
    upstreamWebSocket.on("connection", (socket, request) => {
      upstreamPath = request.url ?? "";
      socket.on("message", () => {
        socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "OK" }));
        socket.send(JSON.stringify({
          type: "response.completed",
          response: { id: "ws-1" },
        }));
      });
    });
    await listen(upstreamServer);
    const upstreamAddress = upstreamServer.address() as AddressInfo;
    openServers.push({
      close: async () => {
        for (const client of upstreamWebSocket.clients) client.terminate();
        await new Promise<void>((resolveClose) => upstreamWebSocket.close(() => resolveClose()));
        await closeServer(upstreamServer).close();
      },
    });
    const directory = trafficDumpDirectory();
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      trafficDump: { directory, label: "openai" },
    });
    await proxy.start();

    const client = new WebSocket(`ws://${proxy.address()}/responses`, {
      headers: { authorization: "Bearer sk-secret" },
    });
    const completed = new Promise<void>((resolveCompleted, rejectCompleted) => {
      client.on("open", () => {
        client.send(JSON.stringify({ type: "response.create", model: "gpt-ws" }));
      });
      client.on("message", (data) => {
        const message = JSON.parse(data.toString("utf8")) as { type?: string };
        if (message.type === "response.completed") resolveCompleted();
      });
      client.on("error", rejectCompleted);
    });
    await completed;
    client.close();
    await proxy.close();

    expect(upstreamPath).toBe("/responses");
    const records = readDumpRecords(directory);
    expect(records.find((record) => record.kind === "websocket_handshake"))
      .toMatchObject({
        url: `ws://127.0.0.1:${upstreamAddress.port}/responses`,
        headers: { authorization: "Bearer <redacted>" },
      });
    expect(frameTexts(records, "client")).toEqual([
      JSON.stringify({ type: "response.create", model: "gpt-ws" }),
    ]);
    expect(frameTexts(records, "upstream").join("")).toContain("response.completed");
    expect(readDumpContent(directory)).not.toContain("sk-secret");
  });
});

function trafficDumpDirectory(): string {
  const parent = mkdtempSync(join(tmpdir(), "codex-traffic-dump-"));
  temporaryDirectories.push(parent);
  return join(parent, "traffic");
}

function closeServer(server: ReturnType<typeof createServer>): ProviderProxyTestServer {
  return {
    close: () => new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    }),
  };
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

function postResponses(address: string, body: string): Promise<number> {
  const port = Number(address.split(":")[1]);
  return new Promise<number>((resolveStatus, rejectStatus) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      path: "/responses",
      method: "POST",
      headers: {
        "authorization": "Bearer sk-secret",
        "content-type": "application/json",
      },
    }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
      response.on("error", rejectStatus);
    });
    request.on("error", rejectStatus);
    request.end(body);
  });
}

function dumpFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

function dumpFile(directory: string): string {
  const files = dumpFiles(directory);
  expect(files).toHaveLength(1);
  return join(directory, files[0]!);
}

function readDumpContent(directory: string): string {
  return dumpFiles(directory)
    .map((name) => readFileSync(join(directory, name), "utf8"))
    .join("");
}

function readDumpRecords(directory: string): Array<Record<string, unknown>> {
  return readDumpContent(directory)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function bodyText(
  records: Array<Record<string, unknown>>,
  kind: "request_body" | "response_body",
): string {
  return records
    .filter((record) => record.kind === kind)
    .map((record) => String(record.text))
    .join("");
}

function frameTexts(
  records: Array<Record<string, unknown>>,
  direction: "client" | "upstream",
): string[] {
  return records
    .filter((record) => record.kind === "websocket_frame" && record.direction === direction)
    .map((record) => String(record.text));
}
