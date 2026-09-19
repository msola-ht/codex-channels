import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  type WriteStream,
} from "node:fs";
import {
  createServer,
  request as httpRequest,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { ProviderProxy, type ProviderProxyMetrics } from "../src/provider-proxy/index.js";
import { ModelTrafficDump } from "../src/provider-proxy/traffic-dump.js";
// @ts-expect-error JavaScript reader intentionally has no declaration file.
import { describeDumpExchange, listDumpFiles, summarizeDumpFiles } from "../scripts/traffic-dump-reader.mjs";
import {
  cleanupProviderProxyTestServers,
  type ProviderProxyTestServer,
} from "./provider-proxy-http-test-fixture.js";

const temporaryDirectories: string[] = [];
const openServers: ProviderProxyTestServer[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await cleanupProviderProxyTestServers(openServers);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ModelTrafficDump V2", () => {
  it.each(["http", "websocket"])("uses one failure timestamp for %s metrics and call details", async (transport) => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-failure-timing-"));
    temporaryDirectories.push(directory);
    const metrics: ProviderProxyMetrics[] = [];
    const server = createServer((request) => request.socket.destroy());
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => socket.on("message", () => socket.terminate()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    openServers.push({ close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1", upstreamPort: (server.address() as AddressInfo).port,
      upstreamProtocol: "http", trafficDump: { directory, label: "openai" },
      onMetrics: (metric) => { metrics.push(metric); },
    });
    await proxy.start();
    openServers.push(proxy);
    if (transport === "http") {
      await fetch(`http://${proxy.address()}/responses`, { method: "POST", body: '{"model":"fixture"}' });
    } else {
      const client = new WebSocket(`ws://${proxy.address()}/responses`);
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => client.send('{"type":"response.create","model":"fixture"}'));
        client.once("close", () => resolve());
        client.once("error", reject);
      });
    }
    await vi.waitFor(() => expect(metrics).toHaveLength(1));
    await proxy.close();
    const detail = await describeDumpExchange(listDumpFiles(directory), 1);
    expect(detail.response.callTiming.totalMs).toBe(metrics[0]?.totalDurationMs);
  });

  it("captures stages through a real reused WebSocket without changing forwarding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-call-timing-ws-"));
    temporaryDirectories.push(directory);
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket) => socket.on("message", () => {
      socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "ok" }));
      socket.send(JSON.stringify({ type: "response.completed", response: { status: "completed" } }));
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    openServers.push({ close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } });
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1", upstreamPort: (server.address() as AddressInfo).port,
      upstreamProtocol: "http", trafficDump: { directory, label: "openai" },
    });
    await proxy.start();
    openServers.push(proxy);
    const client = new WebSocket(`ws://${proxy.address()}/responses`);
    try {
      await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
      for (let index = 0; index < 2; index += 1) {
        await new Promise<void>((resolve, reject) => {
          const receive = (data: WebSocket.RawData) => {
            if (JSON.parse(data.toString()).type === "response.completed") {
              client.off("message", receive);
              client.off("error", reject);
              resolve();
            }
          };
          client.on("message", receive);
          client.once("error", reject);
          client.send(JSON.stringify({ type: "response.create", model: "fixture" }));
        });
      }
    } finally { client.terminate(); }
    await proxy.close();
    const files = listDumpFiles(directory);
    for (const id of [1, 2]) {
      const detail = await describeDumpExchange(files, id);
      expect(detail.response.callTiming.firstEventWaitMs).toBeCloseTo(detail.response.firstContentMs);
      expect(detail.response.callTiming.afterFirstEventMs).toBeGreaterThanOrEqual(0);
      expect(detail.response.callTiming.submittedToFirstEventMs).toBeGreaterThanOrEqual(0);
    }
    expect((await describeDumpExchange(files, 2)).response.callTiming.connectionReady).toBe(true);
  });
  it("records monotonic HTTP stages independently of wall-clock changes", async () => {
    const { directory, dump } = fixture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(10000);
    const exchange = dump.beginHttpExchange({ headers: {}, method: "POST", path: "/responses", startedAtMs: 10000, startedAtMonotonicMs: 100 });
    exchange.callTiming!.forwarding(110);
    exchange.callTiming!.requestBodyEnd(120);
    exchange.callTiming!.responseHead(130);
    exchange.observeRequestMetrics({ firstContentMs: 25 });
    exchange.requestEnd();
    exchange.responseHead(200, {});
    vi.setSystemTime(5000);
    exchange.responseEnd(160);
    await dump.close();
    const detail = await describeDumpExchange(listDumpFiles(directory), 1);
    expect(detail.response.callTiming).toMatchObject({
      totalMs: 60, preForwardMs: 10, firstEventWaitMs: 25, afterFirstEventMs: 25,
      receiveRequestMs: 20, waitResponseHeadMs: 10, receiveResponseMs: 30,
    });
  });

  it("keeps WebSocket connection waiting and first-event stages within each call", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginWebSocketExchange({ headers: {}, startedAtMs: Date.now(), url: "/responses" });
    exchange.webSocketFrame("client", Buffer.from('{"type":"response.create"}'), false, 100);
    const first = exchange.callTiming!;
    first.forwarding(110, false);
    first.submitted(150);
    exchange.observeRequestMetrics({ firstContentMs: 70 });
    exchange.webSocketFrame("upstream", Buffer.from('{"type":"response.completed","response":{}}'), false, 250);
    exchange.webSocketFrame("client", Buffer.from('{"type":"response.create"}'), false, 300);
    exchange.callTiming!.forwarding(310, true);
    exchange.callTiming!.submitted(311);
    exchange.observeRequestMetrics({ firstContentMs: 10 });
    exchange.failure("upstream_error", undefined, 340);
    await dump.close();
    const paths = listDumpFiles(directory);
    expect((await describeDumpExchange(paths, 1)).response.callTiming).toMatchObject({
      totalMs: 150, preForwardMs: 10, firstEventWaitMs: 70, afterFirstEventMs: 70,
      submitWaitMs: 40, submittedToFirstEventMs: 30, connectionReady: false,
    });
    expect((await describeDumpExchange(paths, 2)).response.callTiming).toMatchObject({
      totalMs: 40, preForwardMs: 10, firstEventWaitMs: 10, afterFirstEventMs: 20,
      submitWaitMs: 1, submittedToFirstEventMs: 9, connectionReady: true,
    });
  });

  it("does not invent forwarding or first-event stages for a route failure", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({ headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(), startedAtMonotonicMs: 100 });
    exchange.failure("upstream_route", undefined, 120);
    await dump.close();
    const timing = (await describeDumpExchange(listDumpFiles(directory), 1)).response.callTiming;
    expect(timing.totalMs).toBe(20);
    expect(timing.preForwardMs).toBeUndefined();
    expect(timing.firstEventWaitMs).toBeUndefined();
    expect(timing.afterFirstEventMs).toBeUndefined();
  });
  it("binds HTTP metrics to actual collision-resolved sessions", async () => {
    const { directory, dump } = fixture();
    const second = new ModelTrafficDump({ directory, label: "openai", onError: () => undefined });
    const observed: Array<Pick<ProviderProxyMetrics, "firstContentMs" | "traffic">> = [];
    for (const writer of [dump, second]) {
      const exchange = writer.beginHttpExchange({ headers: {}, method: "POST", path: "/responses", startedAtMs: 1_789_776_000_000 });
      const metrics: Pick<ProviderProxyMetrics, "firstContentMs" | "traffic"> = {};
      exchange.observeRequestMetrics(metrics);
      observed.push(metrics);
      exchange.requestEnd();
      exchange.failure("upstream_request");
      await writer.close();
    }
    expect(observed[0]?.traffic?.interaction).toBe(1);
    expect(observed[1]?.traffic?.interaction).toBe(1);
    expect(observed[1]?.traffic?.session).toBe(`${observed[0]?.traffic?.session}-2`);
    for (const metrics of observed) {
      const reference = metrics.traffic!;
      const detail = await describeDumpExchange([join(directory, `${reference.label}-${reference.session}`)], reference.interaction);
      expect(detail.response.failureStage).toBe("上游请求（连接或发送）");
    }
  });
  it.each(["http", "websocket"])("records %s route failures without copying internal error details into the dump", async (transport) => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-route-failure-"));
    temporaryDirectories.push(directory);
    const metrics: ProviderProxyMetrics[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      trafficDump: { directory, label: "openai" },
      resolveUpstream: async () => { throw new Error("private-route-detail"); },
      onMetrics: (metric) => { metrics.push(metric); },
    });
    await proxy.start();
    openServers.push(proxy);
    if (transport === "http") {
      const response = await fetch(`http://${proxy.address()}/responses`, { method: "POST", body: "{}" });
      await response.text();
      expect(response.status).toBe(502);
    } else {
      await new Promise<void>((resolve, reject) => {
        const client = new WebSocket(`ws://${proxy.address()}/responses`);
        client.on("error", (error) => {
          if (error.message.includes("502")) resolve();
          else reject(error);
        });
        client.on("open", () => { client.close(); reject(new Error("unexpected upgrade")); });
      });
    }
    await proxy.close();
    const session = join(directory, readdirSync(directory)[0]!);
    if (transport === "http") {
      const index = readIndex(session);
      expect(index).toHaveLength(2);
      expect(index[1]).toMatchObject({ state: "failed", errorScope: "upstream_route" });
      expect(metrics[0]?.traffic).toMatchObject({ label: "openai", interaction: 1 });
      expect(JSON.stringify(index)).not.toContain("private-route-detail");
    } else {
      expect(metrics[0]?.traffic).toBeUndefined();
      const trace = readdirSync(session).filter((name) => name.startsWith("trace-"))
        .map((name) => readFileSync(join(session, name), "utf8")).join("");
      expect(trace).toContain('"kind":"websocket_handshake"');
      expect(trace).toContain('"scope":"upstream_route"');
      expect(trace).not.toContain("private-route-detail");
    }
  });
  it("keeps HTTP forwarding available when dump storage initialization fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-traffic-v2-proxy-failure-"));
    temporaryDirectories.push(root);
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "blocked");
    const upstream = createServer((request, response) => {
      request.resume();
      request.on("end", () => response.end("upstream-ok"));
    });
    await new Promise<void>((resolveListen) => upstream.listen(0, "127.0.0.1", resolveListen));
    openServers.push({
      close: () => new Promise<void>((resolveClose) => upstream.close(() => resolveClose())),
    });
    const upstreamAddress = upstream.address() as AddressInfo;
    const errors: Error[] = [];
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: upstreamAddress.port,
      upstreamProtocol: "http",
      trafficDump: { directory: blocked, label: "openai" },
      onError: (error) => errors.push(error),
    });
    await proxy.start();
    openServers.push(proxy);

    const result = await new Promise<{ body: string; status: number }>((resolveResponse, reject) => {
      const request = httpRequest({
        hostname: "127.0.0.1",
        method: "POST",
        path: "/responses",
        port: Number(proxy.address().split(":")[1]),
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolveResponse({
          body: Buffer.concat(chunks).toString("utf8"),
          status: response.statusCode ?? 0,
        }));
        response.on("error", reject);
      });
      request.on("error", reject);
      request.end("{}");
    });

    expect(result).toEqual({ body: "upstream-ok", status: 200 });
    expect(errors).toHaveLength(1);
  });

  it("disables dumping without throwing when storage initialization fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "codexc-traffic-v2-failure-"));
    temporaryDirectories.push(root);
    const blocked = join(root, "not-a-directory");
    writeFileSync(blocked, "blocked");
    const errors: Error[] = [];
    const dump = new ModelTrafficDump({
      directory: blocked,
      label: "openai",
      onError: (error) => errors.push(error),
    });
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });

    expect(() => {
      exchange.requestChunk(Buffer.from("{}"));
      exchange.requestEnd();
      exchange.responseHead(200, { "content-type": "application/json" });
      exchange.responseChunk(Buffer.from("{}"));
      exchange.responseEnd();
    }).not.toThrow();
    await dump.close();
    expect(errors).toHaveLength(1);
  });

  it("stores one HTTP request and one terminal SSE response with payload references", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {
        authorization: "Bearer secret",
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "turn",
          thread_id: "thread-1",
          turn_id: "turn-1",
        }),
      },
      method: "POST",
      path: "/responses",
      startedAtMs: Date.now(),
    });
    exchange.requestChunk(Buffer.from(JSON.stringify({ input: ["hello"], model: "gpt-6-astra" })));
    exchange.requestEnd();
    const observedMetrics: { firstContentMs?: number } = {};
    exchange.observeRequestMetrics(observedMetrics);
    observedMetrics.firstContentMs = 12.5;
    exchange.responseHead(200, { "content-type": "text/event-stream" });
    exchange.responseChunk(Buffer.from("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n"));
    const terminal = {
      type: "response.completed",
      response: { model: "gpt-6-astra", output: [{ type: "message", content: "done" }] },
    };
    const encoded = `event: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`;
    exchange.responseChunk(Buffer.from(encoded.slice(0, 30)));
    exchange.responseChunk(Buffer.from(encoded.slice(30)));
    exchange.responseEnd();
    await dump.close();

    const sessions = listDumpFiles(directory);
    expect(sessions).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(sessions[0]!, "manifest.json"), "utf8")))
      .toMatchObject({ label: "openai", version: 2 });
    const index = readIndex(sessions[0]!);
    expect(index.map((record) => record.kind)).toEqual(["request", "response"]);
    expect(index[0]).toMatchObject({
      headers: { authorization: "Bearer <redacted>" },
      id: 1,
      requestKind: "turn",
      requestModel: "gpt-6-astra",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(index[1]).toMatchObject({
      eventType: "response.completed",
      responseModels: ["gpt-6-astra"],
      state: "completed",
    });
    expect(index[0]!.payload.parts[0]).toMatchObject({ file: "payload-1.bin", offset: 0 });

    const detail = await describeDumpExchange(sessions, 1);
    expect(JSON.parse(detail.request.body)).toMatchObject({ model: "gpt-6-astra" });
    expect(JSON.parse(detail.response.body)).toEqual(terminal);
    expect(detail.response.firstContentMs).toBe(12.5);
    expect(detail.trace.some((record: { kind: string }) => record.kind === "response_body")).toBe(true);
  });

  it("creates a separate logical interaction for every WebSocket response.create", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginWebSocketExchange({
      headers: { authorization: "Bearer secret" },
      startedAtMs: Date.now(),
      url: "wss://example.test/responses",
    });
    exchange.webSocketFrame("client", textFrame({
      type: "response.create",
      model: "gpt-6-astra",
      client_metadata: { thread_id: "thread-ws" },
    }), false);
    const first: Pick<ProviderProxyMetrics, "firstContentMs" | "traffic"> = { firstContentMs: 23.5 };
    exchange.observeRequestMetrics(first);
    exchange.webSocketFrame("upstream", textFrame({
      type: "response.completed",
      response: { model: "gpt-6-astra", output: [] },
    }), false);
    exchange.webSocketFrame("client", textFrame({
      type: "response.create",
      model: "gpt-6-astra",
      input: ["second"],
    }), false);
    const second: Pick<ProviderProxyMetrics, "firstContentMs" | "traffic"> = {};
    exchange.observeRequestMetrics(second);
    expect(first.traffic?.interaction).toBe(1);
    expect(second.traffic?.interaction).toBe(2);
    expect(first.traffic?.session).toBe(second.traffic?.session);
    exchange.webSocketFrame("upstream", textFrame({
      type: "response.failed",
      response: { model: "gpt-6-astra" },
    }), false);
    await dump.close();

    const sessions = listDumpFiles(directory);
    const list = await summarizeDumpFiles(sessions);
    expect(list.exchanges).toMatchObject([
      { id: 1, state: "completed", threadId: "thread-ws", transport: "websocket" },
      { id: 2, state: "failed", transport: "websocket" },
    ]);
    expect((await describeDumpExchange(sessions, 1)).trace)
      .toHaveLength(2);
    expect((await describeDumpExchange(sessions, 1)).response.firstContentMs).toBe(23.5);
    expect((await describeDumpExchange(sessions, 2)).response.firstContentMs).toBeUndefined();
  });

  it("uses per-call WebSocket metadata instead of the prewarm handshake", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginWebSocketExchange({
      headers: { "x-codex-turn-metadata": JSON.stringify({ request_kind: "prewarm" }) },
      startedAtMs: Date.now(), url: "wss://example.test/responses",
    });
    exchange.webSocketFrame("client", textFrame({
      type: "response.create", model: "model-test",
      client_metadata: {
        thread_id: "thread-current", turn_id: "turn-current",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", turn_id: "turn-current" }),
      },
    }), false);
    exchange.webSocketClose("upstream", 1000, Buffer.alloc(0));
    await dump.close();
    expect(readIndex(listDumpFiles(directory)[0]!)[0]).toMatchObject({
      requestKind: "turn", turnId: "turn-current", threadId: "thread-current",
    });
  });

  it("does not reuse a previous WebSocket response model after the next call closes", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginWebSocketExchange({
      headers: {}, startedAtMs: Date.now(), url: "wss://example.test/responses",
    });
    exchange.webSocketFrame("client", textFrame({
      type: "response.create", model: "request-one",
    }), false);
    exchange.webSocketFrame("upstream", textFrame({
      type: "response.completed", response: { model: "response-one" },
    }), false);
    exchange.webSocketFrame("client", textFrame({
      type: "response.create", model: "request-two",
    }), false);
    exchange.webSocketClose("upstream", 1006, Buffer.alloc(0));
    await dump.close();

    const detail = await describeDumpExchange(listDumpFiles(directory), 2);
    expect(detail).toMatchObject({
      requestModel: "request-two",
      responseModels: [],
      state: "incomplete",
    });
  });

  it("records an explicit failed response when HTTP forwarding aborts", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {},
      method: "POST",
      path: "/responses",
      startedAtMs: Date.now(),
    });
    exchange.requestChunk(Buffer.from("{}"));
    exchange.failure("upstream_request", new Error("offline"));
    await dump.close();

    const detail = await describeDumpExchange(listDumpFiles(directory), 1);
    expect(detail.response).toMatchObject({
      error: "offline",
      errorScope: "upstream_request",
      state: "failed",
    });
  });

  it("keeps an observed completed SSE terminal when the transport closes afterward", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestChunk(Buffer.from("{}"));
    exchange.requestEnd();
    exchange.responseHead(200, { "content-type": "text/event-stream" });
    exchange.responseChunk(Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-astra"}}\n\n',
    ));
    exchange.failure("client_disconnected");
    await dump.close();

    const detail = await describeDumpExchange(listDumpFiles(directory), 1);
    expect(detail.response).toMatchObject({ state: "completed" });
  });

  it("recognizes a terminal SSE response when Content-Type is omitted", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestChunk(Buffer.from("{}"));
    exchange.requestEnd();
    exchange.responseHead(200, {});
    exchange.responseChunk(Buffer.from(
      'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-astra"}}\n\n',
    ));
    exchange.responseEnd();
    await dump.close();

    const detail = await describeDumpExchange(listDumpFiles(directory), 1);
    expect(detail.response).toMatchObject({
      eventType: "response.completed",
      state: "completed",
    });
    expect(JSON.parse(detail.response.body)).toMatchObject({
      response: { model: "gpt-6-astra" },
      type: "response.completed",
    });
    expect(detail.responseModels).toEqual(["gpt-6-astra"]);
  });

  it("stops collecting an oversized unterminated SSE event", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestEnd();
    exchange.responseHead(200, { "content-type": "text/event-stream" });
    exchange.responseChunk(Buffer.from(`data: ${"x".repeat(1_048_577)}`));
    const collector = exchange as unknown as {
      sseTerminal: { disabled: boolean; pending: string };
    };
    expect(collector.sseTerminal.pending).toBe("");
    expect(collector.sseTerminal.disabled).toBe(true);
    exchange.responseEnd();
    await dump.close();

    const detail = await describeDumpExchange(listDumpFiles(directory), 1);
    expect(detail.response).toMatchObject({ state: "incomplete" });
    expect(detail.response.body).toBe("");
  });

  it("extracts the request model across raw payload chunks", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    const request = JSON.stringify({
      input: "x".repeat(1_048_576),
      model: "gpt-6-astra",
    });
    const encoded = Buffer.from(request);
    exchange.requestChunk(encoded.subarray(0, 1_048_576));
    exchange.requestChunk(encoded.subarray(1_048_576));
    exchange.requestEnd();
    exchange.responseHead(200, { "content-type": "application/json" });
    exchange.responseChunk(Buffer.from("{}"));
    exchange.responseEnd();
    await dump.close();

    const [summary] = (await summarizeDumpFiles(listDumpFiles(directory))).exchanges;
    expect(summary.requestModel).toBe("gpt-6-astra");
  });

  it("preserves UTF-8 request text when a network chunk ends inside a character", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    const request = JSON.stringify({ input: "汉".repeat(400_000), model: "gpt-6-astra" });
    const encoded = Buffer.from(request);
    let split = 1_048_576;
    while ((encoded[split]! & 0xc0) !== 0x80 || (encoded[split - 1]! & 0xe0) !== 0xe0) {
      split += 1;
    }
    exchange.requestChunk(encoded.subarray(0, split));
    exchange.requestChunk(encoded.subarray(split));
    exchange.requestEnd();
    exchange.responseHead(200, { "content-type": "application/json" });
    exchange.responseChunk(Buffer.from("{}"));
    exchange.responseEnd();
    await dump.close();

    const detail = await describeDumpExchange(listDumpFiles(directory), 1);
    expect(detail.request.body).toBe(request);
  });

  it("extracts the response model across raw JSON payload chunks", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestChunk(Buffer.from("{}"));
    exchange.requestEnd();
    exchange.responseHead(200, { "content-type": "application/json" });
    const response = Buffer.from(JSON.stringify({
      output: "x".repeat(1_048_576),
      model: "gpt-response",
    }));
    exchange.responseChunk(response.subarray(0, 1_048_576));
    exchange.responseChunk(response.subarray(1_048_576));
    exchange.responseEnd();
    await dump.close();

    const [summary] = (await summarizeDumpFiles(listDumpFiles(directory))).exchanges;
    expect(summary.responseModels).toEqual(["gpt-response"]);
  });

  it("closes a rotated payload stream before shutdown", async () => {
    const { directory, dump } = fixture();
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestChunk(Buffer.from("{}"));
    exchange.requestEnd();
    const internals = dump as unknown as {
      sessions: Set<{ payloadWrittenBytes: number }>;
      streams: Set<unknown>;
      writeQueue: Promise<void>;
    };
    const session = [...internals.sessions][0];
    expect(session).toBeDefined();
    session!.payloadWrittenBytes = 64 * 1_048_576;
    exchange.responseHead(200, { "content-type": "application/json" });
    exchange.responseChunk(Buffer.from("{}"));
    exchange.responseEnd();
    await internals.writeQueue;

    expect(readdirSync(listDumpFiles(directory)[0]!)).toContain("payload-2.bin");
    expect(internals.streams.size).toBe(2);
    await dump.close();
  });

  it("waits for destroyed streams to close after a dump failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-traffic-v2-close-failure-"));
    temporaryDirectories.push(directory);
    let observeFailure!: () => void;
    const failureObserved = new Promise<void>((resolve) => {
      observeFailure = resolve;
    });
    const dump = new ModelTrafficDump({
      directory,
      label: "openai",
      onError: () => observeFailure(),
    });
    completeHttpExchange(dump, Date.now());
    const internals = dump as unknown as {
      streams: Set<WriteStream>;
      writeQueue: Promise<void>;
    };
    await internals.writeQueue;
    const [slowStream, failingStream] = [...internals.streams];
    expect(slowStream).toBeDefined();
    expect(failingStream).toBeDefined();
    const destroySlowStream = slowStream!._destroy.bind(slowStream);
    slowStream!._destroy = (error, callback) => {
      setTimeout(() => destroySlowStream(error, callback), 50);
    };

    failingStream!.destroy(new Error("forced dump failure"));
    await failureObserved;
    await dump.close();

    expect(internals.streams.size).toBe(0);
  });

  it("keeps compacted payload parts bounded and private", async () => {
    const { directory, dump } = fixture({ inputItems: 1, itemMaxBytes: 64 });
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestChunk(Buffer.from(JSON.stringify({
      input: [{ text: "old" }, { text: "x".repeat(500) }],
      model: "gpt-6-astra",
    })));
    exchange.requestEnd();
    exchange.responseHead(200, { "content-type": "application/json" });
    exchange.responseChunk(Buffer.from(JSON.stringify({ model: "gpt-6-astra", output: [] })));
    exchange.responseEnd();
    await dump.close();

    const session = listDumpFiles(directory)[0]!;
    const detail = await describeDumpExchange([session], 1);
    const request = JSON.parse(detail.request.body) as { input: unknown[] };
    expect(request.input).toHaveLength(2);
    expect(request.input[0]).toMatchObject({ omitted_items: 1, type: "omitted" });
    expect(request.input[1]).toMatchObject({ type: "truncated" });
    for (const name of readdirSync(session)) {
      expect(statSync(join(session, name)).mode & 0o077).toBe(0);
    }
  });

  it("removes only complete old sessions after retained history exceeds the size budget", async () => {
    const { directory, dump } = fixture();
    const oldest = oldSession(directory, "oldest", 1);
    const newer = oldSession(directory, "newer", 2);
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestEnd();
    await dump.close();

    expect(existsSync(oldest)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });

  it("removes expired historical sessions when the writer starts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-traffic-v2-retention-"));
    temporaryDirectories.push(directory);
    const expired = oldSession(directory, "expired", Date.now() - 31 * 24 * 60 * 60 * 1_000, 0);
    const retained = oldSession(directory, "retained", Date.now() - 29 * 24 * 60 * 60 * 1_000, 0);
    const errors: Error[] = [];

    const dump = new ModelTrafficDump({
      directory,
      label: "openai",
      retentionDays: 30,
      onError: (error) => errors.push(error),
    });
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestEnd();

    expect(errors).toEqual([]);
    expect(existsSync(expired)).toBe(false);
    expect(existsSync(retained)).toBe(true);
    await dump.close();
  });

  it("keeps a session that contains records inside the retention window", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-traffic-v2-retention-activity-"));
    temporaryDirectories.push(directory);
    const active = oldSession(
      directory,
      "active",
      Date.now() - 31 * 24 * 60 * 60 * 1_000,
      0,
    );
    writeFileSync(join(active, "interactions.jsonl"), "recent\n");
    const dump = new ModelTrafficDump({
      directory,
      label: "openai",
      retentionDays: 30,
      onError: () => undefined,
    });
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestEnd();

    expect(existsSync(active)).toBe(true);
    await dump.close();
  });

  it("rotates completed interactions into a new session after one day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const { directory, dump } = fixture({ retentionDays: 30 });
    completeHttpExchange(dump, Date.now());

    vi.setSystemTime(new Date("2026-09-02T00:00:00.001Z"));
    completeHttpExchange(dump, Date.now());
    await dump.close();

    const sessions = listDumpFiles(directory);
    expect(sessions).toHaveLength(2);
    await expect(Promise.all(sessions.map(async (session: string) =>
      (await summarizeDumpFiles([session])).total))).resolves.toEqual([1, 1]);
  });

  it("starts a new session while an older interaction is still active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const { directory, dump } = fixture({ retentionDays: 30 });
    const older = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    older.requestEnd();

    vi.setSystemTime(new Date("2026-09-02T00:00:00.001Z"));
    completeHttpExchange(dump, Date.now());
    older.responseHead(200, { "content-type": "application/json" });
    older.responseChunk(Buffer.from('{"model":"gpt-6-astra","output":[]}'));
    older.responseEnd();
    await dump.close();

    const sessions = listDumpFiles(directory);
    expect(sessions).toHaveLength(2);
    await expect(Promise.all(sessions.map(async (session: string) => {
      const summary = await summarizeDumpFiles([session]);
      return { state: summary.exchanges[0]?.state, total: summary.total };
    }))).resolves.toEqual([
      { state: "completed", total: 1 },
      { state: "completed", total: 1 },
    ]);
  });

  it("rotates a long-lived WebSocket between logical interactions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const { directory, dump } = fixture({ retentionDays: 30 });
    const socket = dump.beginWebSocketExchange({
      headers: {}, startedAtMs: Date.now(), url: "wss://example.test/responses",
    });
    const first: Pick<ProviderProxyMetrics, "traffic"> = {};
    const second: Pick<ProviderProxyMetrics, "traffic"> = {};
    socket.webSocketFrame("client", textFrame({ type: "response.create", model: "gpt-6-astra" }), false);
    socket.observeRequestMetrics(first);
    socket.webSocketFrame("upstream", textFrame({
      type: "response.completed", response: { id: "resp-1", output: [] },
    }), false);

    vi.setSystemTime(new Date("2026-09-02T00:00:00.001Z"));
    socket.webSocketFrame("client", textFrame({ type: "response.create", model: "gpt-6-astra" }), false);
    socket.observeRequestMetrics(second);
    socket.webSocketFrame("upstream", textFrame({
      type: "response.completed", response: { id: "resp-2", output: [] },
    }), false);
    await dump.close();

    const sessions = listDumpFiles(directory);
    expect(sessions).toHaveLength(2);
    expect(first.traffic?.interaction).toBe(1);
    expect(second.traffic?.interaction).toBe(1);
    expect(first.traffic?.session).not.toBe(second.traffic?.session);
    for (const [metric, responseId] of [[first, "resp-1"], [second, "resp-2"]] as const) {
      const reference = metric.traffic!;
      const detail = await describeDumpExchange([join(directory, `${reference.label}-${reference.session}`)], reference.interaction);
      expect(detail.response.responseId).toBe(responseId);
    }
    await expect(Promise.all(sessions.map(async (session: string) =>
      (await summarizeDumpFiles([session])).total))).resolves.toEqual([1, 1]);
  });

  it("keeps expired sessions when time retention is disabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-traffic-v2-retention-off-"));
    temporaryDirectories.push(directory);
    const expired = oldSession(directory, "expired", 1, 0);
    const dump = new ModelTrafficDump({
      directory,
      label: "openai",
      retentionDays: 0,
      onError: () => undefined,
    });
    const exchange = dump.beginHttpExchange({
      headers: {}, method: "POST", path: "/responses", startedAtMs: Date.now(),
    });
    exchange.requestEnd();

    expect(existsSync(expired)).toBe(true);
    await dump.close();
  });
});

function fixture(options: { inputItems?: number; itemMaxBytes?: number; retentionDays?: number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codexc-traffic-v2-"));
  temporaryDirectories.push(directory);
  const errors: Error[] = [];
  const dump = new ModelTrafficDump({
    directory,
    label: "openai",
    onError: (error) => errors.push(error),
    ...options,
  });
  expect(errors).toEqual([]);
  return { directory, dump };
}

function textFrame(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function completeHttpExchange(dump: ModelTrafficDump, startedAtMs: number): void {
  const exchange = dump.beginHttpExchange({
    headers: {}, method: "POST", path: "/responses", startedAtMs,
  });
  exchange.requestEnd();
  exchange.responseHead(200, { "content-type": "application/json" });
  exchange.responseChunk(Buffer.from('{"model":"gpt-6-astra","output":[]}'));
  exchange.responseEnd();
}

function readIndex(session: string): Array<Record<string, unknown> & {
  payload: { parts: Array<Record<string, unknown>> };
}> {
  return readFileSync(join(session, "interactions.jsonl"), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown> & {
      payload: { parts: Array<Record<string, unknown>> };
    });
}

function oldSession(directory: string, session: string, createdAtMs: number, sizeMiB = 200): string {
  const path = join(directory, `openai-${session}`);
  mkdirSync(path, { mode: 0o700 });
  const manifest = join(path, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify({ createdAtMs, label: "openai", session, version: 2 }),
  );
  const payload = join(path, "payload-1.bin");
  writeFileSync(payload, "");
  truncateSync(payload, sizeMiB * 1_048_576);
  const timestamp = new Date(createdAtMs);
  utimesSync(manifest, timestamp, timestamp);
  utimesSync(payload, timestamp, timestamp);
  utimesSync(path, timestamp, timestamp);
  return path;
}
