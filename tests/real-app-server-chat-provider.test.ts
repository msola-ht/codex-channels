import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ChatCompletionsBridge } from "../src/provider-proxy/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";
import type { ThreadStartResponse, TurnStartResponse } from "../src/codex-protocol/index.js";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { applyClinePassConfiguration } from "../scripts/cline-pass-setup.mjs";
import { loadManagedProviderAppServers, withProviderBaseUrl } from "../runtime/model-provider-runtime.mjs";
import { waitFor } from "./support/real-app-server-helpers.js";

const contract = process.env.RUN_CODEX_CONTRACT === "1" ? it : it.skip;
const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC";
contract.each([
  { emptyOpening: false, effort: "high", useDefault: true, incomplete: false },
  { emptyOpening: false, effort: "high", useDefault: true, incomplete: true },
  { emptyOpening: false, effort: "high", useDefault: true, streamError: true },
  { emptyOpening: true, effort: "none", useDefault: false },
  { emptyOpening: false, effort: "low", useDefault: false },
  { emptyOpening: false, effort: "max", useDefault: false },
])("Cline Pass preserves items and tool follow-up ($effort, empty opening: $emptyOpening, incomplete: $incomplete, stream error: $streamError)", async ({ emptyOpening, effort, useDefault, incomplete, streamError }) => {
  const root = mkdtempSync(join(tmpdir(), "chat-contract-"));
  const environment = { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  const bodies: Array<{ tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string; tool_call_id?: string }> }> = [];
  const backend = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      expect(request.url).toBe("/v1/chat/completions");
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as typeof bodies[number]);
      const first = bodies.length === 1;
      const delta = first ? { tool_calls: [{ index: 0, id: "fixture-call", type: "function", function: { name: bodies.at(-1)!.tools.find(tool => tool.function.name.endsWith("schedule_task"))!.function.name, arguments: JSON.stringify({ action: "list" }) } }] } : { content: "Chat tool round trip complete" };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null, usage?: unknown) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
      if (emptyOpening) send({ role: "assistant", content: "" });
      if (first) {
        send({ reasoning: "Inspect scheduled tasks first.", reasoning_details: [{ type: "reasoning.text", text: "Inspect scheduled tasks first.", format: "unknown", index: 0 }] });
        send(delta);
        send({ content: "Checking tasks." }, "tool_calls");
      } else {
        send({ reasoning: "Review task results." });
        send({ content: "First answer. " });
        send({ reasoning: "Double check." });
        send(delta, streamError ? null : incomplete ? "length" : "stop", { prompt_tokens: 20, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 12 } });
      }
      if (!first && streamError) response.write(`data: ${JSON.stringify({ choices: [{ finish_reason: "error", error: { code: "context_length_exceeded", message: "private upstream diagnostic" } }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  let rpc: JsonRpcClient | undefined;
  let bridge: ChatCompletionsBridge | undefined;
  try {
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address(); if (!address || typeof address === "string") throw new Error("No listener");
    bridge = new ChatCompletionsBridge({ upstreamHost: "127.0.0.1", upstreamPort: address.port, upstreamProtocol: "http", upstreamBasePath: "/v1" });
    await bridge.start();
  writePrivateFileAtomicSync(join(environment.CODEX_CONNECT_HOME, "providers", "deepseek", "models.json"), JSON.stringify({ models: [{
    slug: "deepseek-flash", display_name: "DeepSeek Flash", visibility: "list", supported_in_api: true,
    context_window: 64000, max_context_window: 128000, input_modalities: ["text", "image"],
    default_reasoning_level: "high", supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort })),
  }] }));
    writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), 'model_provider = "openai"\n');
    await applyClinePassConfiguration({ apiKey: "sk_fixture" }, { environment });
    const managed = loadManagedProviderAppServers(environment)[0]!;
    const runtime = { ...managed, arguments: withProviderBaseUrl(managed.arguments, managed.provider, `http://${bridge.address()}`) };
    rpc = new JsonRpcClient(new StdioTransport({ codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: root, environment: { ...environment, ...runtime.childEnvironment }, createCodexProcessInvocation: args => ({ file: process.env.CODEX_BINARY ?? "codex", args: [...args, ...runtime.arguments] }) }), 15000);
    const turns: Array<{ id: string; status: string; error?: unknown }> = [];
    const started: Array<{ type: string; id: string }> = [];
    const completed: Array<{ type: string; id: string }> = [];
    const deltas: Array<{ itemId: string; delta: string }> = [];
    rpc.onNotification(notification => {
      if (notification.method === "turn/completed") turns.push((notification.params as { turn: typeof turns[number] }).turn);
      if (notification.method === "item/started") started.push((notification.params as { item: typeof started[number] }).item);
      if (notification.method === "item/completed") completed.push((notification.params as { item: typeof completed[number] }).item);
      if (notification.method === "item/agentMessage/delta") deltas.push(notification.params as typeof deltas[number]);
    });
    rpc.setServerRequestHandler(async request => {
      if (request.method !== "item/tool/call") throw new Error("Unexpected privileged request");
      expect(request.params).toMatchObject({ tool: "schedule_task", arguments: { action: "list" } });
      return { contentItems: [{ type: "inputText", text: "Gateway scheduled tasks: empty" }], success: true };
    });
    await rpc.connect();
    const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: { cwd: root, modelProvider: "cline-pass", sandbox: "read-only", approvalPolicy: "never", ephemeral: true, dynamicTools: [{ type: "function", name: "schedule_task", description: "List fixture tasks", inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false } }] } });
    const { turn } = await rpc.request<TurnStartResponse>({ method: "turn/start", params: { threadId: thread.id, ...(!useDefault ? { effort } : {}), input: [{ type: "text", text: "List scheduled tasks", text_elements: [] }, { type: "image", url: imageUrl }] } });
    await waitFor(() => turns.some(entry => entry.id === turn.id), 15000);
    expect(turns).toContainEqual(expect.objectContaining({ id: turn.id, status: incomplete || streamError ? "failed" : "completed" }));
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body).toMatchObject({ reasoning: { effort } });
      expect(body.messages).toContainEqual(expect.objectContaining({ role: "user", content: expect.arrayContaining([
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } },
      ]) }));
    }
    if (streamError) expect(JSON.stringify(turns)).not.toContain("private upstream diagnostic");
    expect(deltas.map(item => item.delta).join("")).toBe("Checking tasks.First answer. Chat tool round trip complete");
    for (const delta of deltas) {
      expect(started.filter(item => item.id === delta.itemId)).toEqual([expect.objectContaining({ type: "agentMessage" })]);
      if (!streamError) expect(completed.filter(item => item.id === delta.itemId)).toEqual([expect.objectContaining({ type: "agentMessage" })]);
    }
    const reasoningItems = started.filter(item => item.type === "reasoning");
    expect(reasoningItems).toHaveLength(3);
    expect(new Set(reasoningItems.map(item => item.id)).size).toBe(3);
    expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning: "Inspect scheduled tasks first.", content: "Checking tasks.", tool_calls: [expect.objectContaining({ id: "fixture-call" })] }));
    expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "fixture-call", content: expect.stringContaining("Gateway scheduled tasks: empty") }));
  } finally {
    await rpc?.close(); await bridge?.close(); backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
