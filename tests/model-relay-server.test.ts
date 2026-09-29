import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync, mkdirSync, truncateSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ClientRequest, createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRelayServer, type PreparedRelayProvider, type RelayMetric, type RelayPolicy } from "../src/model-relay/index.js";
import { RelayMetricsSender } from "../src/model-relay/index.js";
import { sendRelayMetrics, RelayTrafficDump, pruneModelTrafficDumpSessions } from "../src/provider-proxy/index.js";
// @ts-expect-error JavaScript reader intentionally has no declaration file.
import { describeDumpExchange } from "../scripts/traffic-dump-reader.mjs";
import * as retention from "../src/provider-proxy/traffic-dump-retention.js";
import { relayDebugHeaders } from "../src/provider-proxy/relay-debug-headers.js";
import { RelayMetricsComposition } from "../src/bootstrap/relay-metrics-composition.js";
import { BufferedModelRequestMetricsWriter, SqliteModelRequestMetricsStore } from "../src/observability/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
const secret = Buffer.alloc(32, 3);
const authorization = `Bearer cr1.key-a.${secret.toString("base64url")}`;
const config = (): RelayPolicy => ({ enabled: true, maxConcurrency: 8, burst: 8, requestsPerMinute: 60,
  accounts: [{ provider: "clp-a" }],
  callers: [{ callerId: "caller-a", keyId: "key-a", credentialGeneration: 1, secretSha256: createHash("sha256").update(secret).digest("hex"),
    enabled: true, provider: "clp-a", models: ["fixture/model"] }] });
const body = { model: "fixture/model", messages: [{ role: "user", content: "hello" }] };
const answer = { id: "reply-1", model: "fixture/model", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2 } };
const frame = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
async function fixture(reply: (request: IncomingMessage, response: ServerResponse) => void,
  prepareOverride?: (prepared: PreparedRelayProvider) => Promise<PreparedRelayProvider>, sink?: (sample: RelayMetric) => void, dump?: RelayTrafficDump, debug = false, policy: RelayPolicy = config()) {
  let calls = 0; let preparedCount = 0;
  const backend = createServer((request, response) => { calls++; reply(request, response); });
  await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); });
  const address = backend.address(); if (!address || typeof address === "string") throw new Error("fixture");
  const metrics: RelayMetric[] = [];
  const relay = new ModelRelayServer({ ...(dump ? { capture: (provider, signal) => dump.open(provider, signal, debug) } : {}), policy, enqueueMetric: metric => { metrics.push(metric); sink?.(metric); },
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

  it("prepares bounded debug headers without exposing credentials or URL details", () => {
    const result = relayDebugHeaders({
      Authorization: "Bearer PRIVATE", "Proxy-Authorization": "PRIVATE", Cookie: "PRIVATE",
      "set-cookie": ["PRIVATE", "PRIVATE"], "x-api-key": "PRIVATE", "x-access-token": "PRIVATE",
      "x-unknown-client": "PRIVATE", "user-agent": "browser-fixture", accept: "application/json",
      origin: "https://example.test", referer: "https://example.test/private/path?secret=PRIVATE#PRIVATE",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
    expect(result.headers["x-unknown-client"]).toBe("[REDACTED]");
    expect(result.headers["user-agent"]).toBe("browser-fixture");
    expect(result.headers.referer).toBe("https://example.test");
    expect(result.headers["set-cookie"]).toEqual(["[REDACTED]", "[REDACTED]"]);
    expect(result.truncated).toBe(false);
    expect(relayDebugHeaders({ origin: "https://user:pass@example.test", referer: "file:///private" }).headers)
      .toEqual({ origin: "[REDACTED]", referer: "[REDACTED]" });
    expect(relayDebugHeaders({ "user-agent": "中".repeat(1024) }).truncated).toBe(true);
    const many = relayDebugHeaders(Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`x-header-${i}`, "PRIVATE"])));
    expect(many.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(many.headers))).toBeLessThanOrEqual(16 * 1024);
  });

  it("captures the first concurrent requests after initialization without sending cancelled waiters", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-startup-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const original = retention.pruneModelTrafficDumpSessionsAsync;
    const scans = vi.spyOn(retention, "pruneModelTrafficDumpSessionsAsync").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    cleanups.push(async () => { scans.mockRestore(); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)), undefined, undefined, dump);
    try {
      const cancelled = new AbortController();
      const waiting = dump.open("clp-a", cancelled.signal);
      cancelled.abort(); await expect(waiting).rejects.toThrow();
      const first = f.post(); const second = f.post();
      await vi.waitFor(() => expect(f.preparedCount()).toBe(2));
      expect(f.calls()).toBe(0); expect(scans).toHaveBeenCalledOnce();
      resume();
      expect((await first).status).toBe(200); expect((await second).status).toBe(200);
      await vi.waitFor(() => expect(f.metrics).toHaveLength(2));
      expect(f.metrics.every(metric => metric.traffic)).toBe(true);
      expect(f.metrics[0]!.traffic).not.toEqual(f.metrics[1]!.traffic);
    } finally { resume(); }
  });

  it("rechecks revocation after waiting for capture initialization", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-revoke-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const original = retention.pruneModelTrafficDumpSessionsAsync;
    const scans = vi.spyOn(retention, "pruneModelTrafficDumpSessionsAsync").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    cleanups.push(async () => { scans.mockRestore(); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    const f = await fixture((_request, response) => response.end(JSON.stringify(answer)), undefined, undefined, dump);
    try {
      const pending = f.post();
      await vi.waitFor(() => expect(scans).toHaveBeenCalledOnce());
      const policy = config();
      f.relay.admission.apply({ ...policy, callers: policy.callers.map(caller => ({ ...caller, enabled: false })) });
      await pending;
      expect(f.calls()).toBe(0);
      resume(); await dump.prepare();
      expect(f.calls()).toBe(0);
      expect(f.metrics).toHaveLength(0);
    } finally { resume(); }
  });

  it("coalesces asynchronous maintenance without blocking forwarding or pruning active captures", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-maintenance-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const history = join(directory, "relay.chat-history"); mkdirSync(history);
    writeFileSync(join(history, "manifest.json"), JSON.stringify({ version: 2, label: "relay.chat", session: "history", createdAtMs: Date.now() }));
    const syncScans = vi.spyOn(retention, "pruneModelTrafficDumpSessions");
    cleanups.push(async () => { syncScans.mockRestore(); });
    const original = retention.pruneModelTrafficDumpSessionsAsync;
    const scans = vi.spyOn(retention, "pruneModelTrafficDumpSessionsAsync");
    cleanups.push(async () => { scans.mockRestore(); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)), undefined, undefined, dump);
    await dump.prepare();
    for (let index = 0; index < 20; index++) dump.begin("clp-a")!.finish("disconnected");
    expect(scans).toHaveBeenCalledTimes(1);
    expect(syncScans).not.toHaveBeenCalled();
    const active = dump.begin("clp-a")!;
    const clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 61_000);
    cleanups.push(async () => { clock.mockRestore(); });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    scans.mockImplementationOnce(async (options, signal) => { await gate; return original({ ...options, maximumBytes: 0 }, signal); });
    try {
      dump.begin("clp-a")!.finish("disconnected");
      await vi.waitFor(() => expect(scans).toHaveBeenCalledTimes(2));
      // Rotate while scanning: both the old active session and newly created session must survive.
      const date = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86400_001);
      cleanups.push(async () => { date.mockRestore(); });
      // More than 56 small calls previously exhausted the full 9 MiB reservation per call.
      const policy = config(); f.relay.admission.apply({ ...policy, requestsPerMinute: 0 });
      for (let index = 0; index < 70; index++) {
        expect(await (await f.post()).json()).toMatchObject({ choices: answer.choices });
      }
      expect(f.metrics).toHaveLength(70);
      expect(f.metrics.every(metric => metric.traffic)).toBe(true);
      expect(new Set(f.metrics.map(metric => `${metric.traffic!.session}/${metric.traffic!.interaction}`)).size).toBe(70);
      expect(scans).toHaveBeenCalledTimes(2);
    } finally { active.finish("disconnected"); resume(); }
    await scans.mock.results[1]!.value;
    expect(readdirSync(directory)).not.toContain("relay.chat-history");
    await dump.close();
    for (const metric of f.metrics) {
      const ref = metric.traffic!;
      const detail = await describeDumpExchange([join(directory, `relay.chat-${ref.session}`)], ref.interaction);
      expect(detail.request.body).toContain('"model":"fixture/model"');
      expect(detail.response.body).toContain('"id":"reply-1"');
    }
  });
  it("keeps the disk cap while rate limiting maintenance retries", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-full-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const scans = vi.spyOn(retention, "pruneModelTrafficDumpSessionsAsync").mockResolvedValue(512 * 1024 * 1024);
    const dump = new RelayTrafficDump({ directory, onError: () => {} });
    let clock: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await dump.prepare();
      for (let index = 0; index < 20; index++) expect(dump.begin("clp-a")).toBeUndefined();
      expect(scans).toHaveBeenCalledOnce();
      clock = vi.spyOn(performance, "now").mockReturnValue(performance.now() + 2000);
      scans.mockImplementation(async options => { options.onRemoved?.(512 * 1024 * 1024); return 0; });
      expect(dump.begin("clp-a")).toBeUndefined();
      await vi.waitFor(() => {
        const capture = dump.begin("clp-a"); expect(capture).toBeDefined(); capture?.finish("disconnected");
      });
      expect(scans).toHaveBeenCalledTimes(2);
    } finally { await dump.close(); clock?.mockRestore(); scans.mockRestore(); }
  });
  it("cancels a pending scan on shutdown without deleting history after close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-cancel-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const original = retention.pruneModelTrafficDumpSessionsAsync;
    const scans = vi.spyOn(retention, "pruneModelTrafficDumpSessionsAsync").mockImplementationOnce(async (...args) => { await gate; return original(...args); });
    const error = vi.fn(); const dump = new RelayTrafficDump({ directory, onError: error });
    try {
      const prepare = dump.prepare();
      await vi.waitFor(() => expect(scans).toHaveBeenCalledOnce());
      const closing = dump.close(); resume(); await closing; await prepare;
      expect(dump.begin("clp-a")).toBeUndefined(); expect(error).not.toHaveBeenCalled();
    } finally { resume(); await dump.close(); scans.mockRestore(); }
  });

  it.each([0, 7, 30])("uses the configured global retention period (%i days)", async days => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-retention-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const old = join(directory, "relay.chat-history"); mkdirSync(old);
    const oldTime = Date.now() - 8 * 86400_000;
    writeFileSync(join(old, "manifest.json"), JSON.stringify({ version: 2, label: "relay.chat", session: "history", createdAtMs: oldTime }));
    for (const path of [join(old, "manifest.json"), old]) utimesSync(path, new Date(oldTime), new Date(oldTime));
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    dump.setRetentionDays(days); await dump.prepare();
    expect(readdirSync(directory).includes("relay.chat-history")).toBe(days !== 7);
  });

  it("bounds capture, prunes only retired Relay batches and survives restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-budget-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const old = join(directory, "relay.chat-2026-01-01T00-00-00-000Z"); mkdirSync(old);
    const oldTime = Date.now() - 8 * 86400_000;
    writeFileSync(join(old, "manifest.json"), JSON.stringify({ version: 2, label: "relay.chat", session: "2026-01-01T00-00-00-000Z", createdAtMs: oldTime }));
    writeFileSync(join(old, "payload-1.bin"), ""); truncateSync(join(old, "payload-1.bin"), 512 * 1024 * 1024);
    for (const path of [join(old, "manifest.json"), join(old, "payload-1.bin"), old]) utimesSync(path, new Date(oldTime), new Date(oldTime));
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    await dump.prepare();
    const capture = dump.begin("clp-a")!;
    capture.submitted({ ...body, stream: true }, {}, "/v1/chat/completions");
    expect(readdirSync(directory)).not.toContain(old.split("/").at(-1));
    const chunk = { choices: [{ index: 0, delta: { content: "x".repeat(1024 * 1024) } }] };
    for (let index = 0; index < 9; index++) capture.value(chunk, true);
    capture.done(); const reference = capture.finish("finished")!;
    await dump.close();
    pruneModelTrafficDumpSessions({ directory, retentionDays: 0, maximumBytes: 0 });
    const detail = await describeDumpExchange([join(directory, `relay.chat-${reference.session}`)], reference.interaction);
    expect(detail.response.bodyTruncated).toBe(true);
    expect(detail.response.storedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    const restarted = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => restarted.close());
    await restarted.prepare();
    const next = restarted.begin("clp-b")!; next.submitted({ ...body, stream: false }, {}, "/v1/chat/completions");
    const nextRef = next.finish("disconnected")!; await restarted.close();
    expect(nextRef.session).not.toBe(reference.session);
    expect(readdirSync(directory)).toHaveLength(2);
  });
  it("fails capture at the shared pending-write limit with bounded error reporting", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-memory-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const error = vi.fn(); const dump = new RelayTrafficDump({ directory, onError: error }); cleanups.push(() => dump.close());
    await dump.prepare();
    const captures = Array.from({ length: 3 }, () => dump.begin("clp-a")!);
    for (const capture of captures) { capture.submitted({ ...body, stream: false }, {}, "/v1/chat/completions"); capture.value({ content: "x".repeat(6 * 1024 * 1024) }, false); }
    for (const capture of captures) expect(capture.finish("finished")).toBeUndefined();
    await dump.close(); expect(error).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("captures redacted upstream Chat and associates one metric (stream=%s)", async stream => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const errors: Error[] = [];
    const dump = new RelayTrafficDump({ directory, onError: error => errors.push(error) });
    cleanups.push(() => dump.close());
    const payload = stream ? { model: answer.model, choices: [{ delta: { content: "hello" }, finish_reason: "stop" }], usage: answer.usage, secret: "HIDDEN" }
      : { success: true, data: answer, secret: "HIDDEN" };
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json", "set-cookie": "HIDDEN" })
      .end(stream ? frame(payload) + "data: [DONE]\n\n" : JSON.stringify(payload)), undefined, undefined, dump);
    expect(await (await f.post({ ...body, stream, api_key: "HIDDEN", generate: false, client_metadata: { thread_id: "forged", turn_id: "forged" } }, { "user-agent": "fixture-agent" })).text()).toContain("hello");
    await f.relay.close(); await dump.close();
    expect(errors).toEqual([]);
    expect(f.metrics).toHaveLength(1);
    const reference = f.metrics[0]!.traffic!;
    expect(reference.label).toBe("relay.chat");
    const session = join(directory, `relay.chat-${reference.session}`);
    const detail = await describeDumpExchange([session], reference.interaction);
    expect(detail.threadId).toBeUndefined(); expect(detail.turnId).toBeUndefined(); expect(detail.category).toBe("model");
    expect(detail.request.body).toContain("[REDACTED]");
    expect(detail.response.body).toContain("[REDACTED]");
    expect(detail.response.deliveryStatus).toBe("finished");
    expect(detail.responseModels).toEqual([answer.model]);
    if (stream) expect(detail.response.body).toContain("data: [DONE]");
    expect(detail.response.output[0].text).toBe("hello");
    expect(detail.response.usage).toMatchObject({ inputTokens: 3, outputTokens: 2 });
    for (const name of readdirSync(session)) {
      expect(readFileSync(join(session, name), "utf8")).not.toContain("HIDDEN");
      expect(statSync(join(session, name)).mode & 0o777).toBe(0o600);
    }
    expect(statSync(session).mode & 0o777).toBe(0o700);
  });
  it.each([false, true])("keeps invalid choices inspectable in the dump (stream=%s)", async stream => {
    const directory = mkdtempSync(join(tmpdir(), "relay-dump-choices-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    const payload = { choices: [null] };
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" })
      .end(stream ? frame(payload) + "data: [DONE]\n\n" : JSON.stringify(payload)), undefined, undefined, dump);
    await (await f.post({ ...body, stream })).text();
    await f.relay.close(); await dump.close();
    const reference = f.metrics[0]!.traffic!;
    const detail = await describeDumpExchange([join(directory, `relay.chat-${reference.session}`)], reference.interaction);
    expect(detail.response.body).toContain('"choices":[null]');
    expect(detail.response.output).toEqual([]);
    expect(detail.response.deliveryStatus).toBe("failed");
  });
  it("never persists malformed upstream bodies and does not fail forwarding when capture storage fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "relay-dump-invalid-"));
    cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
    const dump = new RelayTrafficDump({ directory: root, onError: () => {} }); cleanups.push(() => dump.close());
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end("MALFORMED-SECRET"), undefined, undefined, dump);
    expect((await f.post()).status).toBe(502); await f.relay.close(); await dump.close();
    const ref = f.metrics[0]!.traffic!;
    const detail = await describeDumpExchange([join(root, `relay.chat-${ref.session}`)], ref.interaction);
    expect(detail.response.body).toBe(""); expect(detail.response.bodyTruncated).toBe(true);
    const file = join(root, "not-a-directory"); writeFileSync(file, "fixture");
    const broken = new RelayTrafficDump({ directory: file, onError: () => {} }); cleanups.push(() => broken.close());
    const good = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)), undefined, undefined, broken);
    expect((await good.post()).status).toBe(200); expect(good.metrics[0]?.traffic).toBeUndefined();
  });

  it.each([false, true])("records four debug stages with one metric and no credentials (stream=%s)", async stream => {
    const directory = mkdtempSync(join(tmpdir(), "relay-debug-four-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    const value = stream ? { model: answer.model, choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }] }
      : { success: true, data: answer };
    const f = await fixture((_req, res) => res.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json", "x-opaque": "PRIVATE" })
      .end(stream ? frame(value) + "data: [DONE]\n\n" : JSON.stringify(value)), undefined, undefined, dump, true);
    const input = stream ? { ...body, stream } : body;
    const reply = await f.post(input, { origin: "https://example.test", referer: "https://example.test/PRIVATE?q=PRIVATE", "x-client": "PRIVATE", cookie: "PRIVATE" });
    const received = await reply.text();
    await f.relay.close(); await dump.close();
    expect(f.metrics).toHaveLength(1);
    const ref = f.metrics[0]!.traffic!;
    const path = join(directory, `relay.chat-${ref.session}`);
    const detail = await describeDumpExchange([path], ref.interaction);
    expect(JSON.parse(detail.debug.inbound.body)).toEqual(input);
    expect(JSON.parse(detail.request.body).stream).toBe(stream);
    expect(detail.debug.delivered.body).toBe(received);
    expect(detail.debug.delivered.state).toBe("finished");
    expect(detail.debug.inbound.headers["x-client"]).toBe("[REDACTED]");
    expect(detail.request.headers.authorization).toBe("[REDACTED]");
    expect(detail.debug.transformations).toContain("headers_filtered");
    if (!stream) { expect(detail.debug.transformations).toContain("stream_defaulted"); expect(detail.debug.transformations).toContain("json_unwrapped"); }
    for (const file of readdirSync(path)) {
      const text = readFileSync(join(path, file), "utf8");
      expect(text).not.toContain("PRIVATE"); expect(text).not.toContain("UPSTREAM-SECRET"); expect(text).not.toContain(authorization);
    }
    const indexes = join(path, "interactions.jsonl");
    writeFileSync(indexes, readFileSync(indexes, "utf8").replace('"debug":{"version":1', '"debug":{"version":2'));
    await expect(describeDumpExchange([path], ref.interaction)).rejects.toThrow("调试转储版本");
  });

  it("marks each debug stage truncated independently and records failed delivery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-debug-limits-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    await dump.prepare(); const capture = dump.begin("clp-a", true)!;
    const request = { ...body, stream: false, padding: "x".repeat(600 * 1024) };
    capture.inbound!(request, { "user-agent": "x".repeat(2048) }); capture.submitted(request, {}, "/v1/chat/completions");
    capture.head(200, {}); capture.value({ content: "x".repeat(4 * 1024 * 1024) }, false);
    capture.delivered!({ error: { code: "fixture" } }, false, 502, {});
    const ref = capture.finish("failed", "fixture")!; await dump.close();
    const detail = await describeDumpExchange([join(directory, `relay.chat-${ref.session}`)], ref.interaction);
    expect(detail.debug.inbound.bodyTruncated).toBe(true); expect(detail.debug.inbound.headersTruncated).toBe(true);
    expect(detail.request.bodyTruncated).toBe(true); expect(detail.response.bodyTruncated).toBe(true);
    expect(detail.debug.delivered.bodyTruncated).toBe(false); expect(detail.debug.delivered.state).toBe("failed");
    expect(detail.debug.delivered.status).toBe(502);
  });

  it("keeps the upstream failure separate from the actual client error response in debug", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-debug-error-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
    const f = await fixture((_req, res) => res.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ choices: null, secret: "DO-NOT-STORE" })), undefined, undefined, dump, true);
    const reply = await f.post(); const received = await reply.text();
    expect(reply.status).toBe(502);
    await f.relay.close(); await dump.close();
    const ref = f.metrics[0]!.traffic!;
    const detail = await describeDumpExchange([join(directory, `relay.chat-${ref.session}`)], ref.interaction);
    expect(detail.response.status).toBe(200); expect(detail.response.body).toContain('"choices":null');
    expect(detail.response.body).not.toContain("DO-NOT-STORE");
    expect(detail.debug.delivered.status).toBe(502); expect(detail.debug.delivered.state).toBe("failed");
    expect(detail.debug.delivered.body).toBe(received); expect(f.metrics).toHaveLength(1);
  });

  it("does not persist debug input when outbound preparation never submits", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-debug-unsubmitted-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const dump = new RelayTrafficDump({ directory, onError: () => {} });
    await dump.prepare(); const capture = dump.begin("clp-a", true)!;
    capture.inbound!({ ...body, privateText: "NO-OUTBOUND-NO-DUMP" }, {});
    expect(capture.finish("failed")).toBeUndefined(); await dump.close();
    for (const session of readdirSync(directory)) expect(readdirSync(join(directory, session))).toEqual(["manifest.json"]);
  });

  it("queues behind ten executing requests and delivers JSON/SSE exactly once after release", async () => {
    const replies: ServerResponse[] = [];
    const f = await fixture((_request, response) => { replies.push(response); });
    const base = config();
    f.relay.admission.apply({ ...base, maxConcurrency: 10, requestsPerMinute: 0,
      accounts: base.accounts, callers: base.callers });
    const running = Array.from({ length: 10 }, () => f.post());
    await vi.waitFor(() => expect(f.calls()).toBe(10));
    const queuedJson = f.post(); const queuedStream = f.post({ ...body, stream: true });
    await vi.waitFor(() => expect(f.relay.diagnostics().queue.waiting).toBe(2));
    expect(f.preparedCount()).toBe(10); expect(f.relay.diagnostics().active).toBe(10);
    replies[0]!.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    await vi.waitFor(() => expect(f.calls()).toBe(11));
    replies[10]!.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    expect((await queuedJson).status).toBe(200);
    await vi.waitFor(() => expect(f.calls()).toBe(12));
    replies[11]!.writeHead(200, { "content-type": "text/event-stream" }).end(frame({
      id: "reply-1", model: "fixture/model", choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }], usage: answer.usage,
    }) + "data: [DONE]\n\n");
    expect(await (await queuedStream).text()).toContain("data: [DONE]");
    for (const response of replies.slice(1, 10)) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    await Promise.all((await Promise.all(running)).map(response => response.text()));
    await vi.waitFor(() => expect(f.metrics).toHaveLength(12));
    expect(new Set(f.metrics.map(metric => metric.relayRequestId)).size).toBe(12);
    expect(f.metrics.every(metric => metric.status === "completed")).toBe(true);
    expect(f.relay.diagnostics()).toMatchObject({ active: 0, queue: { pending: 0, waiting: 0, bytes: 0 } });
  });
  it("drops disconnected waiters and cancels the rest immediately on shutdown", async () => {
    let upstream: ServerResponse | undefined;
    const f = await fixture((_request, response) => { upstream = response; });
    const base = config();
    f.relay.admission.apply({ ...base, maxConcurrency: 1, requestsPerMinute: 0,
      accounts: base.accounts, callers: base.callers });
    const active = f.post(); await vi.waitFor(() => expect(f.calls()).toBe(1));
    const controller = new AbortController();
    const cancelled = fetch(`${f.relay.address()}/v1/chat/completions`, { method: "POST", signal: controller.signal,
      headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => undefined);
    await vi.waitFor(() => expect(f.relay.diagnostics().queue.waiting).toBe(1));
    controller.abort(); await cancelled;
    await vi.waitFor(() => expect(f.relay.diagnostics().queue.pending).toBe(0));
    const waiting = f.post(); await vi.waitFor(() => expect(f.relay.diagnostics().queue.waiting).toBe(1));
    const close = f.relay.close();
    const rejected = await waiting; expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ error: { phase: "queue", upstream_attempted: false } });
    expect(f.calls()).toBe(1); expect(f.metrics).toHaveLength(0);
    upstream!.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    await (await active).text(); await close;
    expect(f.metrics).toHaveLength(1); expect(f.relay.diagnostics().queue.bytes).toBe(0);
  });
  it("unwraps CLP's successful JSON envelope before delivery and usage settlement", async () => {
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ success: true, data: answer })));
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject(answer);
    expect(f.metrics).toHaveLength(1);
    expect(f.metrics[0]).toMatchObject({ status: "completed", deliveryStatus: "finished", httpStatus: 200,
      responseFormat: "json", responseModel: answer.model, inputTokens: 3, outputTokens: 2 });
    expect(f.metrics[0]?.errorCode).toBeUndefined();
  });
  it.each([
    { success: false, data: answer },
    { success: "true", data: answer },
    { success: true, data: null },
    { success: true, data: { success: true, data: answer } },
    { success: true, data: { error: { code: "server_error", message: "PRIVATE" } } },
    { success: true, data: answer, error: { message: "PRIVATE" } },
    { success: true, data: answer, choices: null },
    { ...answer, success: true, data: answer },
    { ...answer, success: false, data: answer },
  ])("rejects unsuccessful, invalid or ambiguous CLP envelopes (%j)", async payload => {
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify(payload)));
    const response = await f.post(); const text = await response.text();
    expect(response.status).toBe(502); expect(text).not.toContain("PRIVATE");
    expect(f.metrics).toHaveLength(1);
    expect(f.metrics[0]).toMatchObject({ status: "failed", deliveryStatus: "failed", httpStatus: 200 });
    expect(f.metrics[0]?.inputTokens).toBeUndefined();
  });
  it.each([
    [undefined, "choices is missing or is not an array"],
    [[], "choices is empty"],
    [[{}, {}], "choices contains more than one"],
    [["PRIVATE"], "choices[0] is not an object"],
    [[{ index: "PRIVATE" }], "choices[0].index must be absent or zero"],
  ])("distinguishes invalid choices without exposing their values (%j)", async (choices, reason) => {
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ...answer, choices })));
    const response = await f.post(); const text = await response.text();
    expect(response.status).toBe(502); expect(text).not.toContain("PRIVATE");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "invalid_upstream_choices", message: expect.stringContaining(reason as string) } });
    expect(f.metrics).toHaveLength(1);
  });
  it.each(["key", "catalog"])("explains model authorization rejection at the %s boundary without sending upstream", async boundary => {
    const f = await fixture((_request, response) => response.end("unexpected"),
      boundary === "catalog" ? async prepared => ({ ...prepared, models: [] }) : undefined);
    const response = await f.post({ ...body, model: boundary === "key" ? "PRIVATE-model" : body.model });
    const text = await response.text();
    expect(response.status).toBe(403); expect(text).not.toContain("PRIVATE-model");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "model_not_allowed", upstream_attempted: false,
      phase: boundary === "key" ? "input" : "prepare", message: expect.stringContaining("GET /v1/models") } });
    expect(text).toContain("[model_not_allowed;");
    expect(f.calls()).toBe(0); expect(f.metrics).toHaveLength(0);
    expect(f.preparedCount()).toBe(boundary === "key" ? 0 : 1);
  });
  it.each([
    ["content_type", "text/event-stream", "data: PRIVATE\n\n"],
    ["json", "application/json", "PRIVATE not JSON"],
    ["metadata", "application/json", { ...answer, created: "PRIVATE" }],
    ["choices", "application/json", { ...answer, choices: "PRIVATE" }],
    ["message", "application/json", { ...answer, choices: [{ message: { content: { secret: "PRIVATE" } }, finish_reason: "stop" }] }],
    ["tools", "application/json", { ...answer, choices: [{ message: { tool_calls: "PRIVATE" }, finish_reason: "stop" }] }],
    ["finish", "application/json", { ...answer, choices: [{ message: { content: "PRIVATE" }, finish_reason: "unsupported" }] }],
    ["usage", "application/json", { ...answer, usage: { prompt_tokens: "PRIVATE" } }],
  ])("reports safe JSON response diagnostics for %s and correlates the metric", async (part, contentType, payload) => {
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": contentType as string })
      .end(typeof payload === "string" ? payload : JSON.stringify(payload)));
    const response = await f.post();
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain("PRIVATE");
    const result = JSON.parse(text) as { error: { message: string; request_id: string } };
    expect(result).toMatchObject({ error: { code: `invalid_upstream_${String(part)}`, phase: "upstream", upstream_status: 200, upstream_attempted: true } });
    expect(result.error.message).toContain(`invalid_upstream_${String(part)}`);
    expect(result.error.message).toContain("upstream_http=200");
    expect(result.error.request_id).toBe(response.headers.get("x-relay-request-id"));
    expect(f.metrics).toHaveLength(1);
    expect(f.metrics[0]).toMatchObject({ relayRequestId: result.error.request_id, errorCode: `invalid_upstream_${String(part)}`, httpStatus: 200, deliveryStatus: "failed" });
  });
  it("exposes a safe upstream rejection reason without its free text", async () => {
    const f = await fixture((_request, response) => response.writeHead(400, { "content-type": "application/json" })
      .end(JSON.stringify({ error: { message: "PRIVATE request and credentials" } })));
    const response = await f.post(); const text = await response.text();
    expect(response.status).toBe(502); expect(text).not.toContain("PRIVATE");
    expect(JSON.parse(text)).toMatchObject({ error: { code: "invalid_request_error", upstream_status: 400, message: expect.stringContaining("上游拒绝请求") } });
  });
  it("delivers expanded Chat inputs to the upstream and reports safe parameter errors before preparation", async () => {
    let received: unknown;
    const f = await fixture((request, response) => {
      const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => { received = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        expect(request.headers.authorization).toBe("Bearer UPSTREAM-SECRET");
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)); });
    });
    const invalid = await f.post({ ...body, n: 2 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { param: "n", message: "n: Relay supports only one choice (n=1)", upstream_attempted: false } });
    expect(f.preparedCount()).toBe(0);
    const input = { ...body, max_tokens: 100, top_p: 0.8, stream_options: { include_usage: true },
      reasoning: { effort: "none" }, tools: [], vendor_extension: { value: null },
      provider: "forged", url: "http://127.0.0.1:1", authorization: "FORGED", model_base_url: "http://127.0.0.1:1",
      messages: [{ role: "developer", content: "instructions" }, { role: "user", content: [
        { type: "text", text: "hello" }, { type: "image_url", image_url: { url: "http://127.0.0.1:1/image" } }] }] };
    const response = await f.post(input); expect(response.status).toBe(200); await response.text();
    expect(received).toEqual({ ...input, stream: false }); expect(f.metrics).toHaveLength(1);
  });
  it("keeps HTTP delivery successful while Gateway metrics IPC is absent, without retrying after recovery", async () => {
    const directory = mkdtempSync(join(tmpdir(), "relay-missing-gateway-"));
    cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
    const path = join(directory, "metrics.sock");
    const send = vi.fn((envelope: Parameters<typeof sendRelayMetrics>[1], signal: AbortSignal) => sendRelayMetrics(path, envelope, signal));
    const sender = new RelayMetricsSender(send); cleanups.push(() => sender.close());
    const f = await fixture((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer)),
      undefined, sample => sender.enqueue(sample));
    const response = await f.post();
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject(answer);
    await vi.waitFor(() => expect(sender.diagnostics().unconfirmed).toBe(1));
    expect(sender.diagnostics()).toMatchObject({ accepted: 0, rejected: 0, local_dropped: 0, pending: 0, active: 0 });
    const store = new SqliteModelRequestMetricsStore(join(directory, "metrics.sqlite3"));
    const writer = new BufferedModelRequestMetricsWriter(store); cleanups.push(() => writer.close());
    const receiver = new RelayMetricsComposition({ path, writer, authorize: () => undefined });
    await receiver.apply(true); cleanups.push(() => receiver.close());
    await sender.close(); await writer.waitForCurrentWrites();
    expect(send).toHaveBeenCalledTimes(1); expect(store.count()).toBe(0);
    expect(f.metrics).toHaveLength(1); expect(f.relay.diagnostics().active).toBe(0);
  });
  it("enforces the total deadline despite upstream heartbeats and settles only once", async () => {
    const timeout = globalThis.setTimeout;
    const clock = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback, delay, ...args) => timeout(callback, delay === 300_000 ? 150 : delay, ...args));
    try {
      let closed = false;
      const f = await fixture((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ choices: [{ delta: { content: "partial" } }] }));
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 10);
        response.once("close", () => { closed = true; clearInterval(heartbeat); });
      });
      const response = await f.post({ ...body, stream: true }); const text = await response.text();
      expect(response.status).toBe(200); expect(text).toContain("request_timeout"); expect(text).not.toContain("[DONE]");
      await vi.waitFor(() => expect(closed).toBe(true));
      expect(f.metrics).toHaveLength(1); expect(f.metrics[0]).toMatchObject({ status: "failed", errorCode: "request_timeout", httpStatus: 200 });
      expect(f.relay.diagnostics().active).toBe(0);
    } finally { clock.mockRestore(); }
  });
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
    const response = await f.post(body, { "user-agent": "translator/1.0" }); expect(response.status).toBe(200); await response.text();
    await sender.close(); expect(sender.diagnostics()).toMatchObject({ accepted: 1, unconfirmed: 0 });
    await writer.waitForCurrentWrites();
    const rows = store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", callerId: "caller-a", limit: 10 });
    expect(rows.records).toHaveLength(1); expect(rows.records[0]).toMatchObject({ callerId: "caller-a", threadId: null, turnId: null, inputTokens: 3, userAgent: "translator/1.0" });
    await receiver.apply(false);
    await expect(sendRelayMetrics(path, { version: 1, providerId: "clp-a", relayRequestId: f.metrics[0]!.relayRequestId, sample: f.metrics[0]! }, AbortSignal.timeout(1000))).rejects.toThrow();
  });
  it("does not record a client User-Agent removed by hop-by-hop filtering", async () => {
    let upstreamUa: string | undefined;
    const f = await fixture((request, response) => {
      upstreamUa = request.headers["user-agent"];
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
    const client = httpRequest(`${f.relay.address()}/v1/chat/completions`, { method: "POST", headers: {
      authorization, "content-type": "application/json", "user-agent": "must-not-record", connection: "close, user-agent" } });
    const ready = once(client, "response"); client.end(JSON.stringify(body));
    const [response] = await ready as [IncomingMessage];
    for await (const chunk of response) { void chunk; }
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(f.metrics).toHaveLength(1));
    expect(upstreamUa).toBeUndefined(); expect(f.metrics[0]?.userAgent).toBeUndefined();
  });
  it("authenticates, prepares, sends direct JSON and emits one real-caller sample", async () => {
    let incoming: unknown; let headers: IncomingMessage["headers"] | undefined;
    const f = await fixture((request, response) => {
      expect(request.url).toBe("/v1/chat/completions"); headers = request.headers;
      const chunks: Buffer[] = []; request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => { incoming = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
        response.writeHead(200, { "content-type": "application/json", "set-cookie": "PRIVATE" }).end(JSON.stringify({ ...answer, metadata: "PRIVATE" })); });
    });
    const client = httpRequest(`${f.relay.address()}/v1/chat/completions`, { method: "POST", headers: { authorization, "content-type": "application/json", cookie: "PRIVATE", "x-codex-turn-metadata": "FORGED", "x-provider": "other",
      "user-agent": "fixture-client/1", "http-referer": "https://client.example", "x-title": "Fixture",
      "x-client-option": "preserve", "proxy-authorization": "PRIVATE", "x-api-key": "PRIVATE",
      "x-forwarded-for": "1.2.3.4", connection: "close, x-hop", "x-hop": "PRIVATE" } });
    const ready = once(client, "response"); client.end(JSON.stringify(body));
    const [response] = await ready as [IncomingMessage];
    const received: Buffer[] = []; for await (const chunk of response) received.push(Buffer.from(chunk as Buffer));
    expect(response.statusCode).toBe(200); expect(response.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(Buffer.concat(received).toString()) as unknown).toMatchObject(answer);
    expect(incoming).toEqual({ ...body, stream: false });
    expect(f.metrics[0]?.userAgent).toBe("fixture-client/1");
    expect(headers?.authorization).toBe("Bearer UPSTREAM-SECRET");
    expect(headers?.cookie).toBeUndefined(); expect(headers?.["x-codex-turn-metadata"]).toBeUndefined();
    expect(headers).toMatchObject({ "user-agent": "fixture-client/1", "http-referer": "https://client.example",
      "x-title": "Fixture", "x-client-option": "preserve", "accept-encoding": "identity" });
    for (const key of ["proxy-authorization", "x-api-key", "x-forwarded-for", "x-hop", "x-provider"]) expect(headers?.[key], key).toBeUndefined();
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
  it.each(["rotation", "reasoning"])("cancels pending preparation and ignores its late result after %s", async change => {
    let release!: () => void; let preparing!: () => void;
    const ready = new Promise<void>(resolve => { preparing = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(() => { throw new Error("late send"); }, async prepared => { preparing(); await pending; return prepared; });
    const result = f.post(); await ready;
    const policy = config(); f.relay.admission.apply({ ...policy, callers: policy.callers.map(caller => change === "rotation" ? ({ ...caller, credentialGeneration: 2 }) : ({ ...caller, reasoning: "off" })) });
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

it.each([false, true])("forces reasoning off on the outbound copy for JSON/SSE (%s), preserving other parameters", async stream => {
  const directory = mkdtempSync(join(tmpdir(), "relay-reasoning-debug-"));
  cleanups.push(async () => { rmSync(directory, { recursive: true, force: true }); });
  const dump = new RelayTrafficDump({ directory, onError: () => {} }); cleanups.push(() => dump.close());
  const model = "cline-pass/deepseek-v4.1-flash";
  const policy = config();
  policy.callers = policy.callers.map(caller => ({ ...caller, models: [model], reasoning: "off" }));
  let outbound: Record<string, unknown> | undefined;
  const f = await fixture((request, response) => {
    let text = ""; request.setEncoding("utf8"); request.on("data", chunk => { text += chunk; });
    request.on("end", () => {
      outbound = JSON.parse(text) as Record<string, unknown>;
      if (stream) response.writeHead(200, { "content-type": "text/event-stream" }).end(frame({ id: "a", model, choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
      else response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...answer, model }));
    });
  }, async prepared => ({ ...prepared, models: [model] }), undefined, dump, true, policy);
  const input = { model, stream, temperature: 0, reasoning: { effort: "high" }, thinking: { type: "enabled" }, reasoning_effort: "high", enable_thinking: true,
    messages: [{ role: "assistant", content: "history", reasoning: "keep history" }, { role: "user", content: "test" }] };
  const response = await f.post(input);
  expect(response.status).toBe(200); await response.text();
  expect(outbound).toEqual({ model, stream, temperature: 0, reasoning: { effort: "none" }, messages: input.messages });
  expect(input.reasoning.effort).toBe("high");
  await vi.waitFor(() => expect(f.metrics).toHaveLength(1));
  await dump.close();
  const ref = f.metrics[0]!.traffic!;
  const detail = await describeDumpExchange([join(directory, `relay.chat-${ref.session}`)], ref.interaction);
  expect(JSON.parse(detail.debug.inbound.body)).toEqual(input);
  expect(JSON.parse(detail.request.body)).toEqual(outbound);
  const denied = await f.post({ ...input, extra_body: { thinking: true } });
  expect(denied.status).toBe(400); expect(await denied.text()).toContain("extra_body.thinking");
  expect(f.calls()).toBe(1);
});
