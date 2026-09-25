import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";

const contract = process.env.RUN_CODEX_CONTRACT === "1" ? it : it.skip;
const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAb0lEQVR4nO3PAQkAAAyEwO9feoshgnABdNvJ8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ3I8QUNyPEFDcjxBQ2oPcf88OIhvJ6vAAAAAElFTkSuQmCC";
contract.each([
  { emptyOpening: false, effort: "high", useDefault: true, incomplete: false },
  { emptyOpening: false, effort: "high", useDefault: true, incomplete: true },
  { emptyOpening: false, effort: "high", useDefault: true, streamError: true },
  { emptyOpening: true, effort: "none", useDefault: false },
  { emptyOpening: false, effort: "low", useDefault: false },
  { emptyOpening: false, effort: "max", useDefault: false },
  { emptyOpening: false, effort: "high", useDefault: true, fullReasoning: true },
])("CLP preserves items and tool follow-up ($effort, empty opening: $emptyOpening, incomplete: $incomplete, stream error: $streamError, full reasoning: $fullReasoning)", async ({ emptyOpening, effort, useDefault, incomplete, streamError, fullReasoning }) => {
  const root = mkdtempSync(join(tmpdir(), "chat-contract-"));
  const environment = { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  const reasoningField = fullReasoning ? "reasoning_content" : "reasoning";
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
        send({ [reasoningField]: "Inspect scheduled tasks first.", reasoning_details: [{ type: "reasoning.text", text: "Inspect scheduled tasks first.", format: "unknown", index: 0 }] });
        send(delta);
        send({ content: "Checking tasks." }, "tool_calls");
      } else {
        send({ [reasoningField]: "Review task results." });
        send({ content: "First answer. " });
        send({ [reasoningField]: "Double check." });
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
    await applyClinePassConfiguration({accountId:"test", apiKey: "sk_fixture" }, { environment });
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
    const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: { cwd: root, modelProvider: "clp-test", sandbox: "read-only", approvalPolicy: "never", ephemeral: true, dynamicTools: [{ type: "function", name: "schedule_task", description: "List fixture tasks", inputSchema: { type: "object", properties: { action: { type: "string" } }, required: ["action"], additionalProperties: false } }] } });
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
    expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", [reasoningField]: "Inspect scheduled tasks first.", content: "Checking tasks.", tool_calls: [expect.objectContaining({ id: "fixture-call" })] }));
    expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "fixture-call", content: expect.stringContaining("Gateway scheduled tasks: empty") }));
    if (!incomplete && !streamError) {
      const next = await rpc.request<TurnStartResponse>({ method: "turn/start", params: { threadId: thread.id, input: [{ type: "text", text: "Continue", text_elements: [] }] } });
      await waitFor(() => turns.some(entry => entry.id === next.turn.id), 15000);
      expect(turns).toContainEqual(expect.objectContaining({ id: next.turn.id, status: "completed" }));
      expect(bodies).toHaveLength(3);
      expect(bodies[2]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", [reasoningField]: "Inspect scheduled tasks first." }));
      expect(bodies[2]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", [reasoningField]: "Review task results.Double check.", content: "First answer. Chat tool round trip complete" }));
    }
  } finally {
    await rpc?.close(); await bridge?.close(); backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);

contract.each(["custom", "tool_search"] as const)("executes %s through the Chat bridge using real Codex tool shapes", async kind => {
  const root = mkdtempSync(join(tmpdir(), "chat-tools-contract-"));
  const environment = { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  const bodies: Array<{ tools: Array<{ function: { name: string; description?: string } }>; messages: Array<{ role: string; content?: string; reasoning_content?: string }> }> = [];
  const backend = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as typeof bodies[number];
      bodies.push(body);
      const step = bodies.length;
      const toolStep = step === 1 || (kind === "tool_search" && step === 2);
      const target = kind === "custom" ? "apply_patch" : step === 1 ? "tool_search" : "fixture_list";
      const tool = body.tools.find(tool => tool.function.name.endsWith(target));
      const argumentsText = kind === "custom"
        ? JSON.stringify({ input: "*** Begin Patch\n*** Add File: fixture.txt\n+chat patch verified\n*** End Patch" })
        : step === 1 ? JSON.stringify({ query: "fixture_list", limit: null }) : "{}";
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta: unknown, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      send({ reasoning_content: `Step ${step}.` });
      send(toolStep
        ? { tool_calls: [{ index: 0, id: `call-${step}`, type: "function", function: { name: tool?.function.name ?? "missing-tool", arguments: argumentsText } }] }
        : { content: "Tools verified" }, toolStep ? "tool_calls" : "stop");
      response.end("data: [DONE]\n\n");
    });
  });
  let rpc: JsonRpcClient | undefined;
  let bridge: ChatCompletionsBridge | undefined;
  try {
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address(); if (!address || typeof address === "string") throw new Error("No listener");
    bridge = new ChatCompletionsBridge({ upstreamHost: "127.0.0.1", upstreamPort: address.port, upstreamProtocol: "http" });
    await bridge.start();
    const catalog = createResponsesModelCatalog([{ id: "fixture", name: "Fixture", contextWindow: 64000, reasoningEfforts: ["high"], defaultReasoningEffort: "high", supportsImages: false }], "fixture");
    const models = catalog.models.map(model => ({ ...model, supports_search_tool: kind === "tool_search", apply_patch_tool_type: kind === "custom" ? "freeform" : null }));
    const catalogPath = join(root, "models.json");
    writePrivateFileAtomicSync(catalogPath, JSON.stringify({ models }));
    writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), [
      'model = "fixture"', 'model_provider = "fixture"', 'web_search = "disabled"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      '[model_providers.fixture]', 'name = "Fixture"', `base_url = "http://${bridge.address()}"`,
      'wire_api = "responses"', 'supports_websockets = false', 'request_max_retries = 0', 'stream_max_retries = 0',
    ].join("\n"));
    rpc = new JsonRpcClient(new StdioTransport({ codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: root, environment }), 15000);
    const turns: Array<{ id: string; status: string }> = [];
    let dynamicCalls = 0;
    rpc.onNotification(notification => {
      if (notification.method === "turn/completed") turns.push((notification.params as { turn: typeof turns[number] }).turn);
    });
    rpc.setServerRequestHandler(async request => {
      if (request.method !== "item/tool/call") throw new Error("Unexpected privileged request");
      expect(request.params).toMatchObject({ tool: "fixture_list", arguments: {} });
      dynamicCalls++;
      return { contentItems: [{ type: "inputText", text: "fixture-list-ok" }], success: true };
    });
    await rpc.connect();
    const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: {
      cwd: root, modelProvider: "fixture", sandbox: "workspace-write", approvalPolicy: "never", ephemeral: true,
      ...(kind === "tool_search" ? { dynamicTools: [{ type: "namespace" as const, name: "fixtures", description: "Fixture tools", tools: [{ type: "function" as const, name: "fixture_list", description: "fixture_list lists fixtures", inputSchema: { type: "object", properties: {}, additionalProperties: false }, deferLoading: true }] }] } : {}),
    } });
    const { turn } = await rpc.request<TurnStartResponse>({ method: "turn/start", params: { threadId: thread.id, input: [{ type: "text", text: "Verify fixture tools", text_elements: [] }] } });
    await waitFor(() => turns.some(entry => entry.id === turn.id), 15000);
    expect(turns).toContainEqual(expect.objectContaining({ id: turn.id, status: "completed" }));
    expect(bodies).toHaveLength(kind === "custom" ? 2 : 3);
    expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "assistant", reasoning_content: "Step 1." }));
    if (kind === "custom") {
      expect(bodies[1]?.messages).toContainEqual(expect.objectContaining({ role: "tool", content: expect.stringContaining("Success") }));
      expect(readFileSync(join(root, "fixture.txt"), "utf8")).toBe("chat patch verified\n");
      expect(bodies[0]?.tools.find(tool => tool.function.name.endsWith("apply_patch"))?.function.description).toContain("lark grammar:");
      expect(dynamicCalls).toBe(0);
    } else {
      expect(bodies[0]?.tools.some(tool => tool.function.name.endsWith("fixture_list"))).toBe(false);
      expect(bodies[1]?.tools.some(tool => tool.function.name.endsWith("fixture_list"))).toBe(true);
      expect(bodies[2]?.messages).toContainEqual(expect.objectContaining({ role: "tool", content: expect.stringContaining("fixture-list-ok") }));
      expect(dynamicCalls).toBe(1);
    }
  } finally {
    await rpc?.close(); await bridge?.close(); backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);

contract("isolates two real Cline App Servers behind one shared Chat proxy", async () => {
  const { ProviderProxy } = await import("../src/provider-proxy/index.js");
  const root = mkdtempSync(join(tmpdir(), "chat-accounts-contract-"));
  const environment = { ...process.env, CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  const received: Array<string | undefined> = [];
  const backend = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      received.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { content: "account ready" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
    });
  });
  const clients: JsonRpcClient[] = [];
  let bridge: ChatCompletionsBridge | undefined;
  let proxy: InstanceType<typeof ProviderProxy> | undefined;
  try {
    await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
    const address = backend.address(); if (!address || typeof address === "string") throw new Error("No listener");
    bridge = new ChatCompletionsBridge({ upstreamHost: "127.0.0.1", upstreamPort: address.port, upstreamProtocol: "http" });
    await bridge.start();
    const url = new URL(`http://${bridge.address()}`);
    const metricsAccounts: Array<string | undefined> = [];
    proxy = new ProviderProxy("127.0.0.1:0", { upstreamHost: url.hostname, upstreamPort: Number(url.port), upstreamProtocol: "http",
      accountIds: ["main", "work"], defaultAccountId: "main", chatDiagnostics: bridge.diagnostics,
      onMetrics: (_metrics, account) => { metricsAccounts.push(account); } });
    await proxy.start();
    writePrivateFileAtomicSync(join(environment.CODEX_CONNECT_HOME, "providers", "deepseek", "models.json"), JSON.stringify({ models: [{
      slug: "deepseek-flash", display_name: "DeepSeek Flash", visibility: "list", supported_in_api: true,
      context_window: 64000, max_context_window: 128000, input_modalities: ["text", "image"],
      default_reasoning_level: "high", supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort, description: effort })),
    }] }));
    writePrivateFileAtomicSync(join(environment.CODEX_HOME, "config.toml"), 'model_provider = "openai"\n');
    for (const accountId of ["main", "work"]) await applyClinePassConfiguration({ accountId, apiKey: `sk_${accountId}` }, { environment });
    const runtimes = loadManagedProviderAppServers(environment);
    expect(runtimes).toHaveLength(2);
    const ready: Array<{ rpc: JsonRpcClient; provider: string; completed: Array<{ id: string; status: string }> }> = [];
    // The service initializes its primary App Server before starting provider instances.
    for (const managed of runtimes) {
      const account = managed.provider.slice(4);
      const args = withProviderBaseUrl(managed.arguments, managed.provider, `http://${proxy!.address()}/go/${account}`);
      let stderr = "";
      const rpc = new JsonRpcClient(new StdioTransport({ onStderr: text => { stderr = (stderr + text).slice(-4096); }, codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: root,
        environment: { ...environment, ...managed.childEnvironment }, createCodexProcessInvocation: base => ({ file: process.env.CODEX_BINARY ?? "codex", args: [...base, ...args] }) }), 15000);
      clients.push(rpc);
      const completed: Array<{ id: string; status: string }> = [];
      rpc.onNotification(notification => { if (notification.method === "turn/completed") completed.push((notification.params as { turn: typeof completed[number] }).turn); });
      try { await rpc.connect(); } catch (error) { throw new Error(`Account ${account} failed: ${stderr}`, { cause: error }); }
      ready.push({ rpc, provider: managed.provider, completed });
    }
    const threadIds = await Promise.all(ready.map(async ({ rpc, provider, completed }) => {
      const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: { cwd: root, modelProvider: provider, sandbox: "read-only", approvalPolicy: "never", ephemeral: true } });
      expect(thread.modelProvider).toBe(provider);
      const { turn } = await rpc.request<TurnStartResponse>({ method: "turn/start", params: { threadId: thread.id, input: [{ type: "text", text: "Say ready", text_elements: [] }] } });
      await waitFor(() => completed.some(item => item.id === turn.id), 15000);
      expect(completed).toContainEqual(expect.objectContaining({ id: turn.id, status: "completed" }));
      return thread.id;
    }));
    expect(new Set(threadIds).size).toBe(2);
    expect(received.sort()).toEqual(["Bearer sk_main", "Bearer sk_work"]);
    expect(metricsAccounts.sort()).toEqual(["main", "work"]);
  } finally {
    await Promise.all(clients.map(client => client.close()));
    await proxy?.close(); await bridge?.close();
    backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30000);
