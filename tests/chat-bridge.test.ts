import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { ChatCompletionsBridge, ProviderProxy } from "../src/provider-proxy/index.js";
import type { ProviderProxyMetrics } from "../src/provider-proxy/index.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function fixture(reply: string, status = 200) {
  let received: unknown;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
      response.writeHead(status, { "content-type": "text/event-stream" });
      // Deliberately split UTF-8 and SSE frame boundaries.
      for (const byte of Buffer.from(reply)) response.write(Buffer.from([byte]));
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
