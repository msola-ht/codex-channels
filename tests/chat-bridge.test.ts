import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error JavaScript reader intentionally has no declaration file.
import { listDumpFiles, describeDumpExchange } from "../scripts/traffic-dump-reader.mjs";
import { ChatDiagnostics, ChatDiagnosticsChannel } from "../src/provider-proxy/chat-diagnostics.js";
import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { ChatCompletionsBridge, ProviderProxy } from "../src/provider-proxy/index.js";
import type { ProviderProxyMetrics } from "../src/provider-proxy/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function fixture(reply: string | ((request: unknown) => string), status = 200) {
  let received: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
      response.writeHead(status, { "content-type": "text/event-stream", "x-request-id": "fixture-request-id" });
      // Deliberately split UTF-8 and SSE frame boundaries.
      for (const byte of Buffer.from(typeof reply === "string" ? reply : reply(received))) response.write(Buffer.from([byte]));
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  const bridge = new ChatCompletionsBridge({ upstreamHost: "127.0.0.1", upstreamPort: address.port, upstreamProtocol: "http" });
  await bridge.start(); cleanups.push(() => bridge.close());
  return { bridge, received: () => received };
}
const body = { model: "fixture", stream: true, input: [{ role: "user", content: "hello" }] };
const frame = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
it("converts split UTF-8 streams and lets the existing proxy measure cached usage", async () => {
  const { bridge, received } = await fixture(frame({ content: "你好" }, "stop") + 'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":12}}}\n\ndata: [DONE]\n\n');
  const url = new URL(`http://${bridge.address()}`);
  const metrics: ProviderProxyMetrics[] = [];
  const proxy = new ProviderProxy("127.0.0.1:0", { upstreamHost: url.hostname, upstreamPort: Number(url.port), upstreamProtocol: "http", onMetrics: value => { metrics.push(value); } });
  await proxy.start(); cleanups.push(() => proxy.close());
  const result = await fetch(`http://${proxy.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  const text = await result.text();
  expect(text).toContain('"text":"你好"');
  expect(text).toContain('"type":"response.completed"');
  expect(received()).toMatchObject({ messages: [{ role: "user", content: "hello" }], stream_options: { include_usage: true } });
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({ cachedInputTokens: 12, inputTokens: 20, outputTokens: 4 });
});
it.each([
  frame({ content: "partial" }),
  frame({ content: "partial" }, "stop"),
  frame({ content: "partial" }, "error") + "data: [DONE]\n\n",
  'data: {"error":{"message":"upstream-secret"}}\n\ndata: [DONE]\n\n',
])("fails incomplete and error streams without leaking upstream data", async reply => {
  const { bridge } = await fixture(reply);
  const result = await fetch(`http://${bridge.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  const text = await result.text();
  expect(text).toContain("response.failed");
  expect(text).not.toContain("response.completed");
  expect(text).not.toContain("upstream-secret");
});
it("preserves HTTP failure status without forwarding the error body", async () => {
  const { bridge } = await fixture("upstream-secret", 429);
  const result = await fetch(`http://${bridge.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  expect(result.status).toBe(429);
  expect(await result.text()).not.toContain("upstream-secret");
});

it.each(["client", "service"])("cancels upstream work when the %s disconnects", async owner => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(frame({ content: "waiting" }));
      response.on("close", upstreamClosed);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No listener");
  const bridge = new ChatCompletionsBridge({ upstreamHost: "127.0.0.1", upstreamPort: address.port, upstreamProtocol: "http" });
  await bridge.start(); cleanups.push(() => bridge.close());
  const controller = new AbortController();
  const result = await fetch(`http://${bridge.address()}/responses`, { method: "POST", body: JSON.stringify(body), signal: controller.signal });
  const pending = result.text().catch(() => "aborted");
  if (owner === "client") controller.abort(); else await bridge.close();
  await closed;
  await pending;
});

it("round-trips a namespaced tool exceeding Chat name length through HTTP", async () => {
  const namespace="mcp__codex_apps__codex_document_control",name="_execute_document_command";
  const {bridge}=await fixture(value=>{
    const request=value as {tools:Array<{function:{name:string}}>;tool_choice:{function:{name:string}}};
    const alias=request.tools[0]!.function.name;
    expect(alias).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(request.tool_choice.function.name).toBe(alias);
    return frame({tool_calls:[{index:0,id:"long-call",type:"function",function:{name:alias,arguments:"{}"}}]},"tool_calls")+"data: [DONE]\n\n";
  });
  const result=await fetch(`http://${bridge.address()}/responses`,{method:"POST",body:JSON.stringify({...body,tools:[{type:"namespace",name:namespace,tools:[{type:"function",name,parameters:{type:"object"}}]}],tool_choice:{type:"function",name,namespace}})});
  expect(result.status).toBe(200);
  const response=await result.text();
  expect(response).toContain('"type":"response.completed"');
  expect(response).toContain(`"name":"${name}"`);
  expect(response).toContain(`"namespace":"${namespace}"`);
});


it.each([true, false])("records diagnostics only for a configured Chat bridge (enabled: %s)", async enabled => {
  const root = mkdtempSync(join(tmpdir(), "chat-diagnostics-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const metadata = { model: "deepseek/flash", id: "upstream-id", usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.01, gateway_cost: 0.02 }, choices: [{ index: 0, delta: { content: "partial", provider_metadata: { gateway: { cost: "0.03", routing: { finalProvider: "deepseek", totalProviderAttemptCount: 1, fallbacksAvailable: ["other"], modelAttempts: [{ providerAttempts: [{ provider: "deepseek", statusCode: 200, success: true }] }], credential: "secret" } }, secret: "secret" } }, finish_reason: "length" }] };
  const { bridge } = await fixture(`data: ${JSON.stringify(metadata)}\n\ndata: [DONE]\n\n`);
  const url = new URL(`http://${bridge.address()}`);
  const proxy = new ProviderProxy("127.0.0.1:0", { upstreamHost: url.hostname, upstreamPort: Number(url.port), upstreamProtocol: "http", ...(enabled ? { chatDiagnostics: bridge.diagnostics } : {}), trafficDump: { directory: root, label: "cline-pass" } });
  await proxy.start(); cleanups.push(() => proxy.close());
  const result = await fetch(`http://${proxy.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  const text = await result.text();
  expect(result.headers.has("trailer")).toBe(false);
  expect(result.headers.has("x-codexc-chat-diagnostics")).toBe(false);
  expect(text).toContain('"type":"response.incomplete"');
  expect(text).not.toContain("upstream-id");
  expect(text).not.toContain("provider_metadata");
  await proxy.close(); cleanups.pop();
  const detail = await describeDumpExchange(listDumpFiles(root), 1, { maxTracePageSize: 1 });
  if (enabled) expect(detail.chatDiagnostics).toMatchObject({ fields: { model: "deepseek/flash", id: "upstream-id", "routing.finalProvider": "deepseek", "usage.cost": 0.01, "usage.gateway_cost": 0.02, "gateway.cost": "0.03" }, truncated: false });
  else expect(detail.chatDiagnostics).toBeUndefined();
  expect(JSON.stringify(detail.chatDiagnostics ?? {})).not.toContain("secret");
  expect(detail.response.body).toContain('"text":"partial"');
  expect(detail.response.state).toBe("incomplete");
});

it("bounds diagnostic data without leaking arbitrary metadata", () => {
  const collector = new ChatDiagnostics();
  collector.header("request-id");
  collector.push({ model: "x".repeat(300), choices: [{ delta: { provider_metadata: { gateway: { routing: { finalProvider: "deepseek", fallbacksAvailable: Array.from({length: 100}, () => "fallback"), clientSessionId: "secret" } } } } }] });
  const value = collector.snapshot();
  expect(value).toMatchObject({ truncated: true, fields: { requestId: "request-id", "routing.finalProvider": "deepseek" } });
  expect(JSON.stringify(value)).not.toContain("secret");
  expect(JSON.stringify(value).length).toBeLessThan(8192);
});

it("cleans diagnostic observers and isolates concurrent requests", () => {
  const channel = new ChatDiagnosticsChannel();
  const first: unknown[] = [], second: unknown[] = [];
  const a = channel.subscribe(value => first.push(value));
  const b = channel.subscribe(value => second.push(value));
  channel.publish(a.id, { fields: { model: "a" }, truncated: false });
  channel.publish(b.id, { fields: { model: "b" }, truncated: false });
  a.close();channel.publish(a.id, { fields: { model: "leaked" }, truncated: false });
  channel.clear();channel.publish(b.id, { fields: { model: "leaked" }, truncated: false });
  expect(first).toEqual([{ fields: { model: "a" }, truncated: false }]);
  expect(second).toEqual([{ fields: { model: "b" }, truncated: false }]);
});

it.each([400, 401, 402, 403, 404, 429, 500, 502, 503])("keeps request IDs and safe diagnostics for HTTP %s failures", async status => {
  const root = mkdtempSync(join(tmpdir(), "chat-http-error-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const { bridge } = await fixture(JSON.stringify({ error: { code: status, message: "private upstream text", metadata: { secret: "credential" } } }), status);
  const url = new URL(`http://${bridge.address()}`);
  const proxy = new ProviderProxy("127.0.0.1:0", { upstreamHost: url.hostname, upstreamPort: Number(url.port), upstreamProtocol: "http", chatDiagnostics: bridge.diagnostics, trafficDump: { directory: root, label: "cline-pass" } });
  await proxy.start();cleanups.push(() => proxy.close());
  const result = await fetch(`http://${proxy.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  const text = await result.text();
  expect(result.status).toBe(status);expect(text).not.toContain("private upstream text");
  await proxy.close();cleanups.pop();
  const detail = await describeDumpExchange(listDumpFiles(root), 1);
  expect(detail.chatDiagnostics.fields).toMatchObject({ requestId: "fixture-request-id", httpStatus: status, "error.stage": "http", "error.retryable": [429, 500, 502, 503].includes(status) });
  expect(JSON.stringify(detail)).not.toContain("credential");
});

it.each(["context_length_exceeded", "content_filter", "rate_limit", "server_error"])("classifies documented mid-stream %s without exposing upstream messages", async code => {
  const { bridge } = await fixture(frame({ content: "partial" }) + `data: ${JSON.stringify({ choices: [{ finish_reason: "error", error: { code, message: "upstream-secret" } }] })}\n\ndata: [DONE]\n\n`);
  const result = await fetch(`http://${bridge.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  const text = await result.text();
  expect(result.status).toBe(200);expect(text).toContain("response.failed");expect(text).toContain(`"code":"${code}"`);expect(text).not.toContain("upstream-secret");
});

it("records diagnostics before a client cancels immediately on the terminal event", async () => {
  const root = mkdtempSync(join(tmpdir(), "chat-terminal-cancel-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  const { bridge } = await fixture(`data: ${JSON.stringify({ model: "actual/model", choices: [{ index: 0, delta: { content: "done", provider_metadata: { gateway: { routing: { finalProvider: "deepseek" } } } }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  const url = new URL(`http://${bridge.address()}`);
  const proxy = new ProviderProxy("127.0.0.1:0", { upstreamHost: url.hostname, upstreamPort: Number(url.port), upstreamProtocol: "http", chatDiagnostics: bridge.diagnostics, trafficDump: { directory: root, label: "cline-pass" } });
  await proxy.start();cleanups.push(() => proxy.close());
  const result = await fetch(`http://${proxy.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  const reader = result.body!.getReader();let text = "";
  while (!text.includes('"type":"response.completed"')) { const item = await reader.read();if (item.done) break;text += new TextDecoder().decode(item.value); }
  expect(text).toContain("response.completed");await reader.cancel();
  await proxy.close();cleanups.pop();
  const detail = await describeDumpExchange(listDumpFiles(root), 1);
  expect(detail.chatDiagnostics.fields).toMatchObject({ model: "actual/model", "routing.finalProvider": "deepseek" });
});

it.each(["not-json", "x".repeat(65 * 1024), JSON.stringify({ error: { code: "unknown-secret", message: "upstream-secret" } })])("uses a safe HTTP fallback for invalid, oversized or unknown errors", async payload => {
  const { bridge } = await fixture(payload, 502);
  const result = await fetch(`http://${bridge.address()}/responses`, { method: "POST", body: JSON.stringify(body) });
  expect(result.status).toBe(502);
  const text = await result.text();
  expect(text).toContain('"code":"server_error"');
  expect(text).not.toContain("secret");
});
