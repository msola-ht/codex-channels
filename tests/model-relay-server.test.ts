import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientRequest, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRelayServer, type PreparedRelayProvider, type RelayMetric, type RelayPolicy } from "../src/model-relay/index.js";
import { RelayMetricsSender } from "../src/model-relay/index.js";
import { sendRelayMetrics } from "../src/provider-proxy/index.js";
import { RelayMetricsComposition } from "../src/bootstrap/relay-metrics-composition.js";
import { BufferedModelRequestMetricsWriter, SqliteModelRequestMetricsStore } from "../src/observability/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
const secret = Buffer.alloc(32, 3);
const authorization = `Bearer cr1.key-a.${secret.toString("base64url")}`;
const config = (): RelayPolicy => ({ enabled: true, maxConcurrency: 8, burst: 8, requestsPerMinute: 60,
  accounts: [{ provider: "clp-a", maxConcurrency: 4, burst: 4, requestsPerMinute: 30 }],
  callers: [{ callerId: "caller-a", keyId: "key-a", credentialGeneration: 1, secretSha256: createHash("sha256").update(secret).digest("hex"),
    enabled: true, provider: "clp-a", models: ["fixture/model"], maxConcurrency: 2, burst: 2, requestsPerMinute: 10 }] });
const body = { model: "fixture/model", messages: [{ role: "user", content: "hello" }] };
const answer = { id: "reply-1", model: "fixture/model", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2 } };
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
async function fixture(reply: (request: IncomingMessage, response: ServerResponse) => void,
  prepareOverride?: (prepared: PreparedRelayProvider) => Promise<PreparedRelayProvider>, sink?: (sample: RelayMetric) => void) {
  let calls = 0; let preparedCount = 0;
  const backend = createServer((request, response) => { calls++; reply(request, response); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
  const address = backend.address(); if (!address || typeof address === "string") throw new Error("fixture");
  const metrics: RelayMetric[] = [];
  const relay = new ModelRelayServer({ policy: config(), enqueueMetric: metric => { metrics.push(metric); sink?.(metric); },
    prepare: async () => {
      preparedCount++;
      const prepared: PreparedRelayProvider = { target: { host: "127.0.0.1", port: address.port, protocol: "http", basePath: "/v1", authorization: "Bearer UPSTREAM-SECRET" },
        models: ["fixture/model", "hidden/model"], recheck: () => {} };
      return prepareOverride ? prepareOverride(prepared) : prepared;
    } });
  await relay.start(0); cleanups.push(() => relay.close());
  const post = (data: unknown = body, headers: Record<string, string> = {}) => fetch(`${relay.address()}/v1/chat/completions`, {
    method: "POST", headers: { authorization, "content-type": "application/json", ...headers }, body: JSON.stringify(data) });
  return { relay, metrics, calls: () => calls, preparedCount: () => preparedCount, post };
}

describe("isolated Relay vertical request chain", () => {
  it.each([false, true])("preserves idle timeout after upstream headers (stream=%s)", async stream => {
    const original = ClientRequest.prototype.setTimeout;
    const timeout = vi.spyOn(ClientRequest.prototype, "setTimeout").mockImplementation(function (this: ClientRequest, milliseconds, callback) {
      return original.call(this, milliseconds === 60_000 ? 50 : milliseconds, callback);
    });
    try {
      const f = await fixture((_request, response) => {
        response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
        response.write(stream ? frame({ choices: [{ delta: { content: "hello" }, finish_reason: null }] }) : '{"choices":[');
      });
      const response = await f.post({ ...body, stream });
      expect(response.status).toBe(stream ? 200 : 504);
      const text = await response.text(); expect(text).toContain("upstream_timeout");
      if (stream) expect(text).not.toContain("[DONE]");
      expect(f.metrics).toHaveLength(1);
      expect(f.metrics[0]).toMatchObject({ status: "failed", errorCode: "upstream_timeout", httpStatus: 200 });
      expect(f.relay.diagnostics().active).toBe(0);
    } finally { timeout.mockRestore(); }
  });
  it("enforces an absolute header deadline even if a slow client keeps sending", async () => {
    const timeout = globalThis.setTimeout;
    const clock = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => timeout(callback, delay === 10_000 ? 80 : delay, ...args));
    try {
      const f = await fixture(() => {});
      const url = new URL(f.relay.address()); const socket = createConnection({ host: url.hostname, port: Number(url.port) });
      socket.on("error", () => {}); await once(socket, "connect");
      socket.write("POST /v1/chat/completions HTTP/1.1\r\nX-Slow: ");
      const drip = setInterval(() => socket.write("x"), 10);
      try { await once(socket, "close"); } finally { clearInterval(drip); socket.destroy(); }
      expect(f.calls()).toBe(0); expect(f.preparedCount()).toBe(0); expect(f.metrics).toHaveLength(0);
    } finally { clock.mockRestore(); }
  });
  it("maps the upstream header deadline to a bounded safe 504 and settles exactly once", async () => {
    const timeout = globalThis.setTimeout;
    const clock = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => timeout(callback, delay === 60_000 ? 50 : delay, ...args));
    try {
      const f = await fixture(() => {});
      const response = await f.post(); expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ error: { code: "upstream_timeout", upstream_attempted: true } });
      expect(f.metrics).toHaveLength(1); expect(f.metrics[0]?.errorCode).toBe("upstream_timeout");
      expect(f.relay.diagnostics().active).toBe(0);
    } finally { clock.mockRestore(); }
  });
  it("waits for accepted request settlement before graceful shutdown returns", async () => {
    let respond!: () => void;
    const f = await fixture((_request, response) => { respond = () => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)); });
    const result = f.post(); await vi.waitFor(() => expect(f.calls()).toBe(1));
    const closing = f.relay.close(); respond();
    const response = await result; await response.text(); await closing;
    expect(f.metrics).toHaveLength(1); expect(f.metrics[0]?.deliveryStatus).toBe("finished");
    expect(f.relay.diagnostics().active).toBe(0);
  });
  it("rejects a chunked oversized upload before preparing or sending", async () => {
    const f = await fixture(() => { throw new Error("must not send"); });
    const request = httpRequest(`${f.relay.address()}/v1/chat/completions`, { method: "POST", headers: { authorization, "content-type": "application/json" } });
    const result = once(request, "response");
    request.write("x".repeat(1024 * 1024)); request.end("x");
    const [response] = await result as [IncomingMessage]; response.resume();
    expect(response.statusCode).toBe(413); expect(f.preparedCount()).toBe(0); expect(f.metrics).toHaveLength(0);
  });
  it("propagates slow-client backpressure and cancels the upstream when that client disconnects", async () => {
    let produced = 0;
    const f = await fixture((_request, response) => {
      const controller = new AbortController(); response.once("close", () => controller.abort());
      response.writeHead(200, { "content-type": "text/event-stream" });
      void (async () => {
        try {
          for (; produced < 400; produced++) {
            if (!response.write(frame({ choices: [{ delta: { content: "x".repeat(64 * 1024) } }] }))) await once(response, "drain", { signal: controller.signal });
          }
          response.end(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
        } catch { /* Disconnect intentionally terminates the producer. */ }
      })();
    });
    const request = httpRequest(`${f.relay.address()}/v1/chat/completions`, { method: "POST", headers: { authorization, "content-type": "application/json" } });
    const ready = once(request, "response"); request.end(JSON.stringify({ ...body, stream: true }));
    const [response] = await ready as [IncomingMessage]; response.pause();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(produced).toBeLessThan(400); response.destroy(); request.destroy();
    await vi.waitFor(() => expect(f.metrics).toHaveLength(1));
    expect(f.metrics[0]).toMatchObject({ deliveryStatus: "disconnected", status: "failed" });
    expect(f.relay.diagnostics().active).toBe(0);
  });
  it("bounds shutdown while preparation ignores cancellation and discards its late material", async () => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(() => { throw new Error("late send"); }, async prepared => { await wait; return prepared; });
    const pending = f.post().catch(() => undefined);
    await vi.waitFor(() => expect(f.preparedCount()).toBe(1));
    // Disabling is immediate, unlike graceful process shutdown's drain period.
    await f.relay.stopListening(); await pending; release();
    await new Promise(resolve => setImmediate(resolve));
    expect(f.calls()).toBe(0); expect(f.metrics).toEqual([]); expect(f.relay.diagnostics().active).toBe(0);
  });
  it("delivers a request through private metrics IPC into the sole Gateway writer", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-chain-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const store = new SqliteModelRequestMetricsStore(join(directory, "metrics.sqlite3"));
    const writer = new BufferedModelRequestMetricsWriter(store);
    cleanups.push(() => writer.close());
    const path = join(directory, "metrics.sock");
    const receiver = new RelayMetricsComposition({ path, writer, authorize: metric => metric.provider === "clp-a" ? undefined : "unknown_provider" });
    await receiver.apply(true); cleanups.push(() => receiver.close());
    const sender = new RelayMetricsSender((envelope, signal) => sendRelayMetrics(path, envelope, signal));
    cleanups.push(() => sender.close());
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)), undefined,
      sample => sender.enqueue(sample));
    const response = await f.post(); expect(response.status).toBe(200); await response.text();
    await sender.close(); expect(sender.diagnostics()).toMatchObject({ accepted: 1, unconfirmed: 0 });
    await writer.waitForCurrentWrites();
    const rows = store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", callerId: "caller-a", limit: 10 });
    expect(rows.records).toHaveLength(1); expect(rows.records[0]).toMatchObject({ callerId: "caller-a", threadId: null, turnId: null, inputTokens: 3 });
    await receiver.apply(false);
    await expect(sendRelayMetrics(path, { version: 1, providerId: "clp-a", relayRequestId: f.metrics[0]!.relayRequestId, sample: f.metrics[0]! }, AbortSignal.timeout(1000))).rejects.toThrow();
  });
  it("authenticates, prepares, sends direct JSON and emits one real-caller sample", async () => {
    let incoming: unknown; let headers: IncomingMessage["headers"] | undefined;
    const f = await fixture((request, response) => {
      expect(request.url).toBe("/v1/chat/completions"); headers = request.headers;
      const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => { incoming = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        response.writeHead(200, { "content-type": "application/json", "set-cookie": "PRIVATE" }).end(JSON.stringify({ ...answer, metadata: "PRIVATE" })); });
    });
    const response = await f.post(body, { cookie: "PRIVATE", "x-codex-turn-metadata": "FORGED", "x-provider": "other" });
    expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.json()).toMatchObject(answer);
    expect(incoming).toEqual({ ...body, stream: false });
    expect(headers?.authorization).toBe("Bearer UPSTREAM-SECRET");
    expect(headers?.cookie).toBeUndefined(); expect(headers?.["x-codex-turn-metadata"]).toBeUndefined();
    expect(f.metrics).toHaveLength(1);
    expect(f.metrics[0]).toMatchObject({ callerId: "caller-a", keyId: "key-a", credentialGeneration: 1, source: "relay", threadId: null, turnId: null,
      status: "completed", deliveryStatus: "finished", inputTokens: 3, outputTokens: 2 });
    expect(f.metrics[0]?.totalTokens).toBeUndefined(); expect(f.relay.diagnostics().active).toBe(0);
  });
  it("does not prepare credentials for invalid keys and lists only the authorized local intersection", async () => {
    const f = await fixture(() => { throw new Error("must not send"); });
    expect((await f.post(body, { authorization: "Bearer wrong" })).status).toBe(401);
    expect(f.preparedCount()).toBe(0);
    const response = await fetch(`${f.relay.address()}/v1/models`, { headers: { authorization } });
    expect(await response.json()).toEqual({ object: "list", data: [{ id: "fixture/model", object: "model", owned_by: "relay" }] });
    expect(f.calls()).toBe(0); expect(f.metrics).toEqual([]);
  });
  it("cancels pending preparation and ignores its late result after rotation", async () => {
    let release!: () => void; let preparing!: () => void;
    const ready = new Promise<void>(resolve => { preparing = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(() => { throw new Error("late send"); }, async prepared => { preparing(); await pending; return prepared; });
    const result = f.post(); await ready;
    const policy = config(); f.relay.admission.apply({ ...policy, callers: policy.callers.map(caller => ({ ...caller, credentialGeneration: 2 })) });
    const response = await result; expect(response.status).toBe(503); await response.text();
    release(); await new Promise(resolve => setImmediate(resolve));
    expect(f.calls()).toBe(0); expect(f.metrics).toEqual([]); expect(f.relay.diagnostics().active).toBe(0);
  });
  it("rechecks material immediately before sending and rejects invalid models before preparation", async () => {
    const f = await fixture(() => { throw new Error("must not send"); }, async prepared => ({ ...prepared, recheck: () => { throw new Error("material changed"); } }));
    expect((await f.post({ ...body, model: "hidden/model" })).status).toBe(403); expect(f.preparedCount()).toBe(0);
    expect((await f.post()).status).toBe(503); expect(f.calls()).toBe(0); expect(f.metrics).toEqual([]);
  });
  it("streams text, holds tools until validated completion, and retains trailing usage", async () => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(frame({ choices: [{ index: 0, delta: { content: "你好", tool_calls: [{ index: 0, id: "call-a", type: "function", function: { name: "lookup", arguments: "{" } }] } }] })
        + frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] })
        + frame({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }) + "data: [DONE]\n\n");
    });
    const response = await f.post({ ...body, stream: true }); const text = await response.text();
    expect(text).toContain("你好"); expect(text).toContain('"arguments":"{}"'); expect(text).not.toContain('"arguments":"{"');
    expect(text).toContain("data: [DONE]"); expect(f.metrics).toHaveLength(1);
    expect(f.metrics[0]).toMatchObject({ status: "completed", inputTokens: 5, outputTokens: 3 });
  });
  it("bounds the assembled downstream tool frame while preserving completed-model versus failed-delivery status", async () => {
    const args = JSON.stringify({ value: "\\".repeat(350_000) });
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "fixture" } }] } }] }));
      for (let offset = 0; offset < args.length; offset += 32_000) response.write(frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(offset, offset + 32_000) } }] } }] }));
      response.end(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n");
    });
    const response = await f.post({ ...body, stream: true });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("data: [DONE]");
    expect(f.metrics[0]).toMatchObject({ status: "completed", deliveryStatus: "failed" });
  });
  it.each(["missing_done", "truncated_tool", "upstream_error"])("does not invent success for %s", async mode => {
    const f = await fixture((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(mode === "upstream_error" ? frame({ error: { code: "server_error", message: "UPSTREAM-SECRET" } })
        : mode === "truncated_tool" ? frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{" } }] }, finish_reason: "tool_calls" }] }) + "data: [DONE]\n\n"
          : frame({ choices: [{ delta: { content: "partial" }, finish_reason: "stop" }] }));
    });
    const response = await f.post({ ...body, stream: true }); const text = await response.text();
    expect(text).not.toContain("UPSTREAM-SECRET"); expect(text).not.toContain("data: [DONE]");
    expect(f.metrics).toHaveLength(1); expect(f.metrics[0]?.status).toBe("failed"); expect(f.relay.diagnostics().active).toBe(0);
  });
  it("does not follow redirects or forward upstream auth failures as caller auth failures", async () => {
    const f = await fixture((_request, response) => response.writeHead(302, { location: "https://example.invalid/private" }).end());
    const response = await f.post(); expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull(); expect(f.calls()).toBe(1); expect(f.metrics).toHaveLength(1);
  });
});
