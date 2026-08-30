import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acquireAppServerProviderLease,
  appServerSupervisorSocketPath,
  ensureAppServerProvider,
  inspectAppServerSupervisor,
  releaseAppServerProvider,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  providerAppServerSocketPath,
  writeCustomPrimaryProviderSwitchingProfile,
} from "../runtime/model-provider-runtime.mjs";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { toConversationInputEvent } from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { ProviderProxy } from "../src/provider-proxy/index.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;

contractSuite("real supervised App Server service", () => {
  it("routes standalone web search through the OpenAI proxy path allowlist", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-search-proxy-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const observedPaths: string[] = [];
    let responsesRequestCount = 0;
    const apiServer = createServer((request, response) => {
      observedPaths.push(`${request.method ?? ""} ${request.url ?? ""}`);
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "gpt-5.6-sol", object: "model", owned_by: "openai" }],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/alpha/search") {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ output: "official docs result", results: [] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        request.resume();
        responsesRequestCount += 1;
        const responseId = `search-proxy-response-${responsesRequestCount}`;
        const events = responsesRequestCount === 1
          ? [
              {
                type: "response.created",
                response: { id: responseId },
              },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: "web-run-contract",
                  namespace: "web",
                  name: "run",
                  arguments: JSON.stringify({
                    search_query: [{ q: "OpenAI Codex docs" }],
                  }),
                },
              },
              completedResponseEvent(responseId),
            ]
          : [
              {
                type: "response.created",
                response: { id: responseId },
              },
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  role: "assistant",
                  id: "search-proxy-message",
                  content: [{ type: "output_text", text: "done" }],
                },
              },
              completedResponseEvent(responseId),
            ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "search proxy contract fixture" } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", resolveListen);
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Search Proxy 合同无法创建本机 API 夹具");
    }
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      upstreamPort: apiAddress.port,
      upstreamProtocol: "http",
      upstreamBasePath: "/v1",
      allowOpenAiApiPaths: true,
    });
    await proxy.start();
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.6-sol"',
      'model_provider = "search-proxy-contract"',
      "",
      "[features]",
      "standalone_web_search = true",
      "",
      "[model_providers.search-proxy-contract]",
      'name = "Search Proxy Contract Provider"',
      `base_url = "http://${proxy.address()}"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "supports_standalone_web_search = true",
      "",
    ].join("\n"), { mode: 0o600 });

    let stderr = "";
    const processHandle = spawn(
      process.env.CODEX_BINARY ?? "codex",
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });
    let client: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    let removeNotification: (() => void) | undefined;
    let completed = false;
    try {
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle.exitCode === null
          ? undefined
          : new Error(appServerFailure("Search Proxy 合同 App Server 启动失败", stderr)),
      );
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();
      const started = await client.startThread(workspace);
      threadId = started.thread.id;
      removeNotification = client.onNotification((notification) => {
        const event = toConversationInputEvent(notification);
        if (event?.type === "turn.completed" && event.threadId === threadId) {
          completed = true;
        }
      });
      await client.startTurn(
        threadId,
        [{ type: "text", text: "Search the OpenAI Codex docs." }],
        "codex_connect:search-proxy-contract",
        workspace,
      );
      await waitFor(() => completed, 15_000);

      expect(observedPaths).toContain("POST /v1/alpha/search");
      expect(responsesRequestCount).toBe(2);
    } finally {
      removeNotification?.();
      if (client && threadId) {
        await client.unsubscribeThread(threadId).catch(() => undefined);
        await client.deleteThread(threadId).catch(() => undefined);
      }
      await client?.close().catch(() => undefined);
      await stopDetachedTestProcess(processHandle, 5_000).catch(() => undefined);
      await proxy.close();
      await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 30_000);

  it("round-trips a dynamic tool call through the real App Server", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-dynamic-tool-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    let requestCount = 0;
    const observedToolCalls: Array<{ tool: string; arguments: unknown }> = [];
    const apiServer = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "dynamic-tool-contract-model", object: "model", owned_by: "contract" }],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        request.resume();
        requestCount += 1;
        const responseId = `dynamic-tool-response-${requestCount}`;
        const events = requestCount === 1
          ? [
              { type: "response.created", response: { id: responseId } },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: "dynamic-tool-call-1",
                  name: "schedule_task",
                  arguments: JSON.stringify({ action: "list" }),
                },
              },
              completedResponseEvent(responseId),
            ]
          : [
              { type: "response.created", response: { id: responseId } },
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  role: "assistant",
                  id: "dynamic-tool-message",
                  content: [{ type: "output_text", text: "tool-ok" }],
                },
              },
              completedResponseEvent(responseId),
            ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "dynamic tool contract fixture" } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", resolveListen);
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Dynamic Tool 合同无法创建本机 Responses 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "dynamic-tool-contract-model"',
      'model_provider = "dynamic-tool-contract"',
      "",
      "[model_providers.dynamic-tool-contract]",
      'name = "Dynamic Tool Contract Provider"',
      `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"), { mode: 0o600 });

    let stderr = "";
    const processHandle = spawn(
      process.env.CODEX_BINARY ?? "codex",
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });
    let client: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    let removeNotification: (() => void) | undefined;
    let completed = false;
    try {
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle.exitCode === null
          ? undefined
          : new Error(appServerFailure("Dynamic Tool 合同 App Server 启动失败", stderr)),
      );
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();
      client.setServerRequestHandler(async (request) => {
        if (request.method !== "item/tool/call") {
          throw new Error(`Dynamic Tool 合同收到意外请求：${request.method}`);
        }
        const params = request.params as {
          tool?: unknown;
          arguments?: unknown;
        } | undefined;
        observedToolCalls.push({
          tool: String(params?.tool ?? ""),
          arguments: params?.arguments,
        });
        return {
          contentItems: [{ type: "inputText", text: "Gateway scheduled tasks: empty" }],
          success: true,
        };
      });
      const started = await client.startThread(workspace, {
        ephemeral: true,
        dynamicTools: [{
          type: "function",
          name: "schedule_task",
          description: "Manage Gateway scheduled tasks.",
          inputSchema: {
            type: "object",
            properties: { action: { type: "string" } },
            required: ["action"],
            additionalProperties: false,
          },
        }],
      });
      threadId = started.thread.id;
      removeNotification = client.onNotification((notification) => {
        const event = toConversationInputEvent(notification);
        if (event?.type === "turn.completed" && event.threadId === threadId) {
          completed = true;
        }
      });
      await client.startTurn(
        threadId,
        [{ type: "text", text: "List scheduled tasks." }],
        "codex_connect:dynamic-tool-contract",
        workspace,
      );
      await waitFor(() => completed, 15_000);

      expect(requestCount).toBe(2);
      expect(observedToolCalls).toEqual([{
        tool: "schedule_task",
        arguments: { action: "list" },
      }]);
    } finally {
      removeNotification?.();
      if (client && threadId) {
        await client.unsubscribeThread(threadId).catch(() => undefined);
        await client.deleteThread(threadId).catch(() => undefined);
      }
      await client?.close().catch(() => undefined);
      await stopDetachedTestProcess(processHandle, 5_000).catch(() => undefined);
      await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 30_000);

  it("attributes native subagent completion activity to the initiating parent Turn", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-subagent-completion-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const parentPrompt = "Spawn the completion contract worker.";
    const childPrompt = "Complete the child contract task.";
    const spawnCallId = "spawn-completion-contract-worker";
    let responseSequence = 0;
    const apiServer = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "subagent-contract-model", object: "model", owned_by: "contract" }],
        }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        request.resume();
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "subagent contract fixture endpoint" } }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        responseSequence += 1;
        const responseId = `subagent-contract-response-${responseSequence}`;
        const events = body.includes(spawnCallId)
          ? [
              { type: "response.created", response: { id: responseId } },
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  role: "assistant",
                  id: "parent-contract-message",
                  content: [{ type: "output_text", text: "parent complete" }],
                },
              },
              completedResponseEvent(responseId),
            ]
          : body.includes(childPrompt)
          ? [
              { type: "response.created", response: { id: responseId } },
              {
                type: "response.output_item.done",
                item: {
                  type: "message",
                  role: "assistant",
                  id: "child-contract-message",
                  content: [{ type: "output_text", text: "child complete" }],
                },
              },
              completedResponseEvent(responseId),
            ]
          : [
              { type: "response.created", response: { id: responseId } },
              {
                type: "response.output_item.done",
                item: {
                  type: "function_call",
                  call_id: spawnCallId,
                  namespace: "collaboration",
                  name: "spawn_agent",
                  arguments: JSON.stringify({
                    message: childPrompt,
                    task_name: "contract_worker",
                    fork_turns: "none",
                  }),
                },
              },
              completedResponseEvent(responseId),
            ];
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) {
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        }
        response.end();
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", resolveListen);
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("子代理完成合同无法创建本机 Responses 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "subagent-contract-model"',
      'model_provider = "subagent-contract"',
      "",
      "[features]",
      "multi_agent_v2 = true",
      "",
      "[model_providers.subagent-contract]",
      'name = "Subagent Contract Provider"',
      `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"), { mode: 0o600 });

    let stderr = "";
    const processHandle = spawn(
      process.env.CODEX_BINARY ?? "codex",
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });
    let client: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    let parentTurnId: string | undefined;
    let removeNotification: (() => void) | undefined;
    const activities: Array<Extract<
      NonNullable<ReturnType<typeof toConversationInputEvent>>,
      { type: "item.subagentActivity" }
    >> = [];
    const parentSequence: string[] = [];
    try {
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle.exitCode === null
          ? undefined
          : new Error(appServerFailure("子代理完成合同 App Server 启动失败", stderr)),
      );
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();
      const started = await client.startThread(workspace, { ephemeral: true });
      threadId = started.thread.id;
      removeNotification = client.onNotification((notification) => {
        const event = toConversationInputEvent(notification);
        if (event?.type === "item.subagentActivity") {
          activities.push(event);
          if (event.kind === "completed") parentSequence.push("subagent.completed");
        } else if (event?.type === "turn.completed" && event.threadId === threadId) {
          parentSequence.push("parent.turn.completed");
        }
      });
      const parentTurn = await client.startTurn(
        threadId,
        [{ type: "text", text: parentPrompt }],
        "codex_connect:subagent-completion-contract",
        workspace,
      );
      parentTurnId = parentTurn.turnId;
      await waitFor(
        () => activities.some(({ kind }) => kind === "completed"),
        15_000,
      );

      const spawned = activities.find(({ kind }) => kind === "started");
      const completed = activities.find(({ kind }) => kind === "completed");
      expect(spawned).toBeDefined();
      expect(completed).toMatchObject({
        threadId,
        turnId: parentTurnId,
        agentThreadId: spawned?.agentThreadId,
        agentPath: spawned?.agentPath,
        kind: "completed",
      });
      expect(parentSequence.indexOf("parent.turn.completed")).toBeGreaterThanOrEqual(0);
      expect(parentSequence.indexOf("subagent.completed")).toBeGreaterThan(
        parentSequence.indexOf("parent.turn.completed"),
      );
    } finally {
      removeNotification?.();
      if (client && threadId) {
        if (parentTurnId) {
          await client.interruptTurn(threadId, parentTurnId).catch(() => undefined);
        }
        await client.unsubscribeThread(threadId).catch(() => undefined);
        await client.deleteThread(threadId).catch(() => undefined);
      }
      await client?.close().catch(() => undefined);
      await stopDetachedTestProcess(processHandle, 5_000).catch(() => undefined);
      await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 30_000);


  it("runs paginated history, active-turn Revert and preserved Queue against local Responses", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-revert-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const apiServerResponses = new Map<ServerResponse, string>();
    const responseIds: string[] = [];
    const requestBodies: string[] = [];
    const apiServer = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "revert-contract-model", object: "model", owned_by: "contract" }],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        request.setEncoding("utf8");
        let body = "";
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          requestBodies.push(body);
          response.writeHead(200, { "content-type": "text/event-stream" });
          const responseId = `revert-contract-response-${responseIds.length + 1}`;
          responseIds.push(responseId);
          response.write(`data: ${JSON.stringify({
            type: "response.created",
            response: { id: responseId },
          })}\n\n`);
          apiServerResponses.set(response, responseId);
          response.once("close", () => apiServerResponses.delete(response));
        });
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "revert contract fixture endpoint" } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Revert 合同无法创建本机 Responses 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "revert-contract-model"',
      'model_provider = "revert-contract"',
      "",
      "[model_providers.revert-contract]",
      'name = "Revert Contract Provider"',
      `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"), { mode: 0o600 });

    let stderr = "";
    const processHandle = spawn(
      process.env.CODEX_BINARY ?? "codex",
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd: process.cwd(),
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });
    let client: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    const completedStatuses = new Map<string, string>();
    const revertedThreadIds: string[] = [];
    let removeNotification: (() => void) | undefined;
    const completeResponse = (responseId: string): void => {
      const response = [...apiServerResponses.entries()]
        .find(([, id]) => id === responseId)?.[0];
      if (!response) {
        throw new Error(`找不到待完成的 Revert Responses 夹具：${responseId}`);
      }
      response.write(`data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: responseId,
          status: "completed",
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
            total_tokens: 2,
          },
        },
      })}\n\n`);
      response.end();
    };
    const startCompletedTurn = async (text: string, index: number): Promise<string> => {
      const started = await client!.startTurn(
        threadId!,
        [{ type: "text", text }],
        `codex_connect:revert-contract-${index}`,
        workspace,
      );
      await waitFor(() => responseIds.length > index, 5_000);
      completeResponse(responseIds[index]!);
      await waitFor(() => completedStatuses.get(started.turnId) === "completed", 10_000);
      return started.turnId;
    };
    try {
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle.exitCode === null
          ? undefined
          : new Error(appServerFailure("Revert 合同 App Server 启动失败", stderr)),
      );
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "workspace-write" },
      );
      await client.connect();
      const started = await client.startThread(workspace);
      threadId = started.thread.id;
      expect(started.thread.historyMode).toBe("paginated");
      removeNotification = client.onNotification((notification) => {
        const event = toConversationInputEvent(notification);
        if (event?.type === "turn.completed") {
          completedStatuses.set(event.turnId, event.status);
        }
        if (event?.type === "thread.reverted") revertedThreadIds.push(event.threadId);
      });

      const firstTurnId = await startCompletedTurn("first revert turn", 0);
      const secondTurnId = await startCompletedTurn("second revert turn", 1);
      const listed = await client.listThreadTurns(threadId, { limit: 25 });
      expect(listed.turns.map((turn) => turn.id)).toEqual([secondTurnId, firstTurnId]);
      expect(listed.turns[0]).toMatchObject({ inputType: "text", textPreview: "second revert turn" });

      const active = await client.startTurn(
        threadId,
        [{ type: "text", text: "active revert turn" }],
        "codex_connect:revert-contract-active",
        workspace,
      );
      await waitFor(() => responseIds.length > 2, 5_000);
      const queuedFirst = await client.addQueueItem(
        threadId,
        "queued first after revert",
        "codex_connect:revert-queue-first",
      );
      const queuedSecond = await client.addQueueItem(
        threadId,
        "queued second after revert",
        "codex_connect:revert-queue-second",
      );
      expect((await client.listQueue(threadId, { limit: 100 })).items.map((item) => item.id))
        .toEqual([queuedFirst.id, queuedSecond.id]);
      const activeReverted = await client.revertThread(threadId, active.turnId);
      expect(activeReverted.thread).toMatchObject({ id: threadId, historyMode: "paginated" });
      expect(completedStatuses.get(active.turnId)).toBe("interrupted");
      await waitFor(() => revertedThreadIds.includes(threadId!), 5_000);
      expect((await client.listQueue(threadId, { limit: 100 })).items.map((item) => item.id))
        .toEqual([queuedFirst.id, queuedSecond.id]);
      await client.startQueueItem(threadId);
      await waitFor(() => requestBodies.length > 3, 5_000);
      expect(requestBodies[3]).toContain("queued first after revert");
      expect(requestBodies[3]).not.toContain("queued second after revert");
      completeResponse(responseIds[3]!);
      await waitFor(() => requestBodies.length > 4, 10_000);
      expect(requestBodies[4]).toContain("queued second after revert");
      completeResponse(responseIds[4]!);
      await waitFor(
        () => [...completedStatuses.values()].filter((status) => status === "completed").length >= 4,
        10_000,
      );
      expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(0);
      const afterQueuedDispatch = await client.listThreadTurns(threadId, { limit: 25 });
      expect(afterQueuedDispatch.turns.map((turn) => turn.textPreview)).toEqual([
        "queued second after revert",
        "queued first after revert",
        "second revert turn",
        "first revert turn",
      ]);
      expect(afterQueuedDispatch.turns.slice(-2).map((turn) => turn.id)).toEqual([
        secondTurnId,
        firstTurnId,
      ]);

      await client.revertThread(threadId, secondTurnId);
      await waitFor(() => revertedThreadIds.length >= 2, 5_000);
      expect((await client.listThreadTurns(threadId, { limit: 25 })).turns.map((turn) => turn.id))
        .toEqual([firstTurnId]);
      await expect(client.revertThread(threadId, "missing-turn")).rejects.toThrow("turn not found");
    } finally {
      removeNotification?.();
      if (threadId) {
        await client?.unsubscribeThread(threadId).catch(() => undefined);
        await client?.deleteThread(threadId).catch(() => undefined);
      }
      await client?.close().catch(() => undefined);
      if (processHandle.exitCode === null) {
        await stopDetachedTestProcess(processHandle, 10_000);
      }
      for (const response of apiServerResponses.keys()) response.end();
      await new Promise<void>((resolveClose, rejectClose) => {
        apiServer.close((error) => error ? rejectClose(error) : resolveClose());
      });
      rmSync(testRuntime, { recursive: true, force: true });
    }
  }, 45_000);

  it("starts a custom Responses primary Provider and maps reasoning notifications", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-custom-provider-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const configPath = join(testRuntime, "config.toml");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const supervisorSocketPath = appServerSupervisorSocketPath(socketPath);
    const apiServer = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "gpt-5.6-terra", object: "model", owned_by: "fixture" }],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        const requestChunks: Buffer[] = [];
        request.on("data", (chunk: Buffer | string) => {
          requestChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        request.on("end", () => {
          const requestBody = Buffer.concat(requestChunks).toString("utf8");
          if (requestBody.includes("trigger policy violation")) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "misalignment_policy_violation",
                message: "This request violated the misalignment policy.",
              },
            }));
            return;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          const encryptedReasoning = Buffer
            .from(`${"b".repeat(550)}step one`)
            .toString("base64");
          const events = [
            { type: "response.created", response: { id: "resp-1" } },
            {
              type: "response.output_item.added",
              item: {
                type: "reasoning",
                id: "reasoning-1",
                summary: [{ type: "summary_text", text: "" }],
              },
            },
            {
              type: "response.reasoning_summary_text.delta",
              delta: "step one",
              summary_index: 0,
            },
            {
              type: "response.output_item.done",
              item: {
                type: "reasoning",
                id: "reasoning-1",
                summary: [{ type: "summary_text", text: "step one" }],
                encrypted_content: encryptedReasoning,
              },
            },
            {
              type: "response.output_item.added",
              item: {
                type: "message",
                role: "assistant",
                id: "message-1",
                content: [],
              },
            },
            { type: "response.output_text.delta", delta: "Done" },
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                role: "assistant",
                id: "message-1",
                content: [{ type: "output_text", text: "Done" }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp-1",
                usage: {
                  input_tokens: 1,
                  input_tokens_details: null,
                  output_tokens: 1,
                  output_tokens_details: null,
                  total_tokens: 2,
                },
              },
            },
          ];
          for (const event of events) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end();
        });
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture endpoint" } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("自定义 Provider 合同无法创建本机 Responses 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "gpt-5.6-terra"',
      "",
      "[model_providers.thirdparty]",
      'name = "Contract Responses Provider"',
      `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"), { mode: 0o600 });
    writeGatewayConfig(configPath, {
      version: 1,
      default_workspace: "integration",
      telegram: {
        bot_token: "integration-token",
        allowed_user_ids: [123],
        message_format: "html",
      },
      network: {},
      codex: {
        binary: process.env.CODEX_BINARY ?? "codex",
        socket_path: socketPath,
        sandbox: "workspace-write",
      },
      approval: { timeout_seconds: 300 },
      storage: { database_path: join(testRuntime, "gateway.sqlite3") },
      logging: { level: "info" },
      workspaces: [{ id: "integration", name: "Integration", cwd: workspace }],
    });

    let stdout = "";
    let stderr = "";
    let client: CodexAppServerClient | undefined;
    const service = spawn(
      process.execPath,
      [resolve("bin/codexc.mjs"), "service-app-server"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_CONNECT_HOME: testRuntime,
          CODEX_CONNECT_CONFIG_FILE: configPath,
          CODEX_HOME: codexHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    service.stdout?.setEncoding("utf8");
    service.stderr?.setEncoding("utf8");
    service.stdout?.on("data", (chunk: string) => {
      stdout = appendDiagnostic(stdout, chunk);
    });
    service.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });

    try {
      await waitFor(
        () => existsSync(socketPath) && stdout.includes("openai 模型统计代理已启动"),
        15_000,
        () => service.exitCode === null && service.signalCode === null
          ? undefined
          : new Error(appServerFailure(
              "自定义 Provider App Server 在就绪前退出",
              `${stdout}\n${stderr}`,
            )),
      );
      expect(await inspectAppServerSupervisor(socketPath)).toMatchObject({
        primaryProvider: "openai",
        managedProviders: [],
        socketPaths: [socketPath],
      });
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();
      expect((await client.listModels()).some(({ model }) => model === "gpt-5.6-terra"))
        .toBe(true);

      const started = await client.startThread(workspace);
      const threadId = started.thread.id;
      let reasoningDeltaCount = 0;
      let turnId: string | undefined;
      let completed = false;
      let policyError: Extract<ReturnType<typeof toConversationInputEvent>, { type: "turn.error" }> | undefined;
      let policyCompleted: Extract<ReturnType<typeof toConversationInputEvent>, { type: "turn.completed" }> | undefined;
      const removeNotification = client.onNotification((notification) => {
        const event = toConversationInputEvent(notification);
        if (event?.type === "item.reasoning.delta" && event.threadId === threadId) {
          reasoningDeltaCount += 1;
        }
        if (
          event?.type === "turn.completed"
          && event.threadId === threadId
        ) {
          completed = true;
        }
        if (event?.type === "turn.error" && event.threadId === threadId) {
          policyError = event;
        }
        if (event?.type === "turn.completed" && event.threadId === threadId && event.status === "failed") {
          policyCompleted = event;
        }
      });
      try {
        const turn = await client.startTurn(
          threadId,
          [{ type: "text", text: "reason through it" }],
          "codex_connect:contract",
          workspace,
        );
        turnId = turn.turnId;
        await waitFor(
          () => reasoningDeltaCount >= 1,
          10_000,
        );
        await waitFor(() => completed, 10_000);

        const policyTurn = await client.startTurn(
          threadId,
          [{ type: "text", text: "trigger policy violation" }],
          "codex_connect:contract-policy",
          workspace,
        );
        turnId = policyTurn.turnId;
        await waitFor(() => policyCompleted !== undefined, 10_000);
        expect(policyError).toMatchObject({
          threadId,
          turnId: policyTurn.turnId,
          willRetry: false,
          errorCode: "misalignmentPolicyViolation",
        });
        expect(policyCompleted).toMatchObject({
          threadId,
          turnId: policyTurn.turnId,
          status: "failed",
          errorCode: "misalignmentPolicyViolation",
        });
      } finally {
        removeNotification();
        if (turnId) {
          await client.interruptTurn(threadId, turnId).catch(() => undefined);
        }
        await client.unsubscribeThread(threadId).catch(() => undefined);
        await client.deleteThread(threadId).catch(() => undefined);
      }
    } finally {
      try {
        await client?.close().catch(() => undefined);
        await stopDetachedTestProcess(service, 10_000);
        await waitFor(() => !existsSync(supervisorSocketPath), 2_000);
      } finally {
        await new Promise<void>((resolveClose, rejectClose) => {
          apiServer.close((error) => error ? rejectClose(error) : resolveClose());
        });
        rmSync(testRuntime, { recursive: true, force: true });
      }
    }
  }, 30_000);

  it("starts an on-demand custom switching App Server with the official catalog", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-custom-switching-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const configPath = join(testRuntime, "config.toml");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const customSocketPath = providerAppServerSocketPath(socketPath, "OpenAI");
    const supervisorSocketPath = appServerSupervisorSocketPath(socketPath);
    const apiServer = createServer((request, response) => {
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture endpoint" } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("自定义切换 Provider 合同无法创建本机 Responses 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), 'model_provider = "openai"\n', {
      mode: 0o600,
    });
    writeCustomPrimaryProviderSwitchingProfile({
      provider: "OpenAI",
      model: "gpt-5.6-terra",
      name: "OpenAI",
      baseUrl: `http://127.0.0.1:${apiAddress.port}/v1`,
      apiKey: "sk-integration-placeholder",
      supportsWebsockets: false,
    }, {
      ...process.env,
      CODEX_CONNECT_HOME: testRuntime,
      CODEX_HOME: codexHome,
    });
    writeGatewayConfig(configPath, {
      version: 1,
      default_workspace: "integration",
      telegram: {
        bot_token: "integration-token",
        allowed_user_ids: [123],
        message_format: "html",
      },
      network: {},
      codex: {
        binary: process.env.CODEX_BINARY ?? "codex",
        socket_path: socketPath,
        sandbox: "workspace-write",
      },
      approval: { timeout_seconds: 300 },
      storage: { database_path: join(testRuntime, "gateway.sqlite3") },
      logging: { level: "info" },
      workspaces: [{ id: "integration", name: "Integration", cwd: workspace }],
    });

    let stdout = "";
    let stderr = "";
    let customClient: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    const service = spawn(
      process.execPath,
      [resolve("bin/codexc.mjs"), "service-app-server"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_CONNECT_HOME: testRuntime,
          CODEX_CONNECT_CONFIG_FILE: configPath,
          CODEX_HOME: codexHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    service.stdout?.setEncoding("utf8");
    service.stderr?.setEncoding("utf8");
    service.stdout?.on("data", (chunk: string) => {
      stdout = appendDiagnostic(stdout, chunk);
    });
    service.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });

    try {
      await waitFor(
        () => existsSync(socketPath) && stdout.includes("openai 模型统计代理已启动"),
        15_000,
        () => service.exitCode === null && service.signalCode === null
          ? undefined
          : new Error(appServerFailure(
              "自定义切换主 App Server 在就绪前退出",
              `${stdout}\n${stderr}`,
            )),
      );
      expect(sameAppServerTopology(await inspectAppServerSupervisor(socketPath), {
        primaryProvider: "openai",
        managedProviders: ["OpenAI"],
        socketPaths: [socketPath, customSocketPath],
      })).toBe(true);

      await ensureAppServerProvider(socketPath, "OpenAI").catch((error) => {
        throw new Error(appServerFailure(
          error instanceof Error ? error.message : String(error),
          `${stdout}\n${stderr}`,
        ), { cause: error });
      });
      customClient = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(customSocketPath)),
        { sandbox: "read-only" },
      );
      await customClient.connect();
      expect((await customClient.listModels()).some(({ model }) => model === "gpt-5.6-terra"))
        .toBe(true);
      const started = await customClient.startThread(workspace);
      threadId = started.thread.id;
      expect(started.thread.modelProvider).toBe("OpenAI");
    } finally {
      if (threadId) {
        await customClient?.unsubscribeThread(threadId).catch(() => undefined);
        await customClient?.deleteThread(threadId).catch(() => undefined);
      }
      await customClient?.close().catch(() => undefined);
      await stopDetachedTestProcess(service, 10_000);
      await waitFor(() => !existsSync(supervisorSocketPath), 2_000);
      await new Promise<void>((resolveClose, rejectClose) => {
        apiServer.close((error) => error ? rejectClose(error) : resolveClose());
      });
      rmSync(testRuntime, { recursive: true, force: true });
    }
  }, 30_000);

  it("starts OpenAI and an on-demand OpenCode Go App Server with matching topology", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const configPath = join(testRuntime, "config.toml");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const openCodeSocketPath = providerAppServerSocketPath(socketPath, "opencode-go");
    const supervisorSocketPath = appServerSupervisorSocketPath(socketPath);
    const providerDirectory = join(testRuntime, "providers", "opencode-go");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const roleConfigPath = join(codexHome, "sf-agent.config.toml");
    writeFileSync(
      roleConfigPath,
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "opencode-go"',
        'model_reasoning_effort = "high"',
        'developer_instructions = "Integration fixture role"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "[features]",
        "multi_agent_v2 = true",
        "",
        "[agents.external]",
        'description = "Integration fixture role"',
        `config_file = ${JSON.stringify(roleConfigPath)}`,
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const catalogPath = join(providerDirectory, "models.json");
    const validCatalog = `${JSON.stringify({
      models: [{
        slug: "deepseek-v4-flash",
        display_name: "DeepSeek-V4-Flash",
        description: "OpenCode Go contract fixture",
        context_window: 200_000,
        default_reasoning_level: "high",
        supported_reasoning_levels: [{
          effort: "high",
          description: "OpenCode Go contract fixture",
        }],
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        availability_nux: null,
        upgrade: null,
        base_instructions: "You are a coding agent.",
        support_verbosity: true,
        default_verbosity: "low",
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "tokens", limit: 10_000 },
        supports_parallel_tool_calls: true,
        experimental_supported_tools: [],
      }],
    })}\n`;
    // 能通过 Gateway 启动校验、但缺少 codex 要求的 display_name，
    // 用于验证首次按需启动失败时服务仍然存活。
    const invalidForCodexCatalog = `${JSON.stringify({
      models: [{
        slug: "deepseek-v4-flash",
        context_window: 200_000,
        default_reasoning_level: "high",
        supported_reasoning_levels: [{
          effort: "high",
          description: "OpenCode Go contract fixture",
        }],
      }],
    })}\n`;
    writeFileSync(
      catalogPath,
      invalidForCodexCatalog,
      { mode: 0o600 },
    );
    writeFileSync(
      join(providerDirectory, "managed.toml"),
      'version = 1\nprovider = "opencode-go"\nmode = "switching"\n',
      { mode: 0o600 },
    );
    writeFileSync(
      join(codexHome, "sf-opencode-go.config.toml"),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "opencode-go"',
        'model_reasoning_effort = "high"',
        `model_catalog_json = ${JSON.stringify(catalogPath)}`,
        "[model_providers.opencode-go]",
        'name = "opencode-go"',
        'base_url = "https://opencode.ai/zen/go/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        'experimental_bearer_token = "sk-integration-placeholder"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    writeGatewayConfig(configPath, {
      version: 1,
      default_workspace: "integration",
      telegram: {
        bot_token: "integration-token",
        allowed_user_ids: [123],
        message_format: "html",
      },
      network: {},
      codex: {
        binary: process.env.CODEX_BINARY ?? "codex",
        socket_path: socketPath,
        sandbox: "workspace-write",
      },
      approval: { timeout_seconds: 300 },
      storage: { database_path: join(testRuntime, "gateway.sqlite3") },
      logging: { level: "info" },
      workspaces: [{ id: "integration", name: "Integration", cwd: workspace }],
    });

    let stdout = "";
    let stderr = "";
    let client: CodexAppServerClient | undefined;
    let openCodeClient: CodexAppServerClient | undefined;
    const service = spawn(
      process.execPath,
      [resolve("bin/codexc.mjs"), "service-app-server"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CODEX_CONNECT_HOME: testRuntime,
          CODEX_CONNECT_CONFIG_FILE: configPath,
          CODEX_HOME: codexHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    service.stdout?.setEncoding("utf8");
    service.stderr?.setEncoding("utf8");
    service.stdout?.on("data", (chunk: string) => {
      stdout = appendDiagnostic(stdout, chunk);
    });
    service.stderr?.on("data", (chunk: string) => {
      stderr = appendDiagnostic(stderr, chunk);
    });

    try {
      await waitFor(
        () => existsSync(socketPath) && stdout.includes("openai 模型统计代理已启动"),
        15_000,
        () => service.exitCode === null && service.signalCode === null
          ? undefined
          : new Error(appServerFailure(
              "service-app-server 在真实 App Server 就绪前退出",
              `${stdout}\n${stderr}`,
            )),
      );

      const topology = await inspectAppServerSupervisor(socketPath);
      expect(sameAppServerTopology(topology, {
        primaryProvider: "openai",
        managedProviders: ["opencode-go"],
        socketPaths: [socketPath, openCodeSocketPath],
      })).toBe(true);

      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      const initialized = await client.connect();
      expect(initialized.userAgent).toContain("codex_connect/");

      await expect(ensureAppServerProvider(socketPath, "opencode-go"))
        .rejects.toThrow("模型 Provider App Server 启动失败：opencode-go（exit=1）");
      expect(service.exitCode).toBeNull();
      expect(await client.listModels()).not.toHaveLength(0);
      expect(await inspectAppServerSupervisor(socketPath)).toMatchObject({
        primaryProvider: "openai",
      });

      writeFileSync(catalogPath, validCatalog, { mode: 0o600 });
      await ensureAppServerProvider(socketPath, "opencode-go").catch((error) => {
        throw new Error(appServerFailure(
          error instanceof Error ? error.message : String(error),
          `${stdout}\n${stderr}`,
        ), { cause: error });
      });
      expect(existsSync(openCodeSocketPath)).toBe(true);
      openCodeClient = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(openCodeSocketPath)),
        { sandbox: "read-only" },
      );
      const openCodeInitialized = await openCodeClient.connect();
      expect(openCodeInitialized.userAgent).toContain("codex_connect/");
      const providerLease = await acquireAppServerProviderLease(socketPath, "opencode-go");
      try {
        expect(await inspectAppServerSupervisor(socketPath)).toMatchObject({
          leasedProviders: ["opencode-go"],
        });
        await expect(releaseAppServerProvider(socketPath, "opencode-go"))
          .resolves.toEqual({ released: false, reason: "leased" });
      } finally {
        await providerLease.close();
      }
      const models = await openCodeClient.listModels();
      expect(models.some(({ model }) => model === "deepseek-v4-flash")).toBe(true);
    } finally {
      try {
        await openCodeClient?.close().catch(() => undefined);
        await client?.close().catch(() => undefined);
        await stopDetachedTestProcess(service, 10_000);
        await waitFor(() => !existsSync(supervisorSocketPath), 2_000);
        expect(existsSync(roleConfigPath)).toBe(true);
        expect(readFileSync(roleConfigPath, "utf8")).not.toContain("api_key");
      } finally {
        rmSync(testRuntime, { recursive: true, force: true });
      }
    }
  }, 45_000);
});

function completedResponseEvent(id: string): Record<string, unknown> {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      usage: {
        input_tokens: 1,
        input_tokens_details: null,
        output_tokens: 1,
        output_tokens_details: null,
        total_tokens: 2,
      },
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  failure?: () => Error | undefined,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    const currentFailure = failure?.();
    if (currentFailure) {
      throw currentFailure;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待 Codex App Server Unix Socket 超时；请检查 App Server stderr");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopDetachedTestProcess(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTestProcessTree(child, "SIGTERM");
  try {
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      timeoutMs,
    );
  } catch (error) {
    signalTestProcessTree(child, "SIGKILL");
    await waitFor(
      () => child.exitCode !== null || child.signalCode !== null,
      2_000,
    );
    throw error;
  }
}

function signalTestProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
    return;
  }
  child.kill(signal);
}

function appendDiagnostic(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-4_000);
}

function appServerFailure(message: string, stderr: string): string {
  const sanitized = stderr
    .replace(/(authorization|token|password|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .trim();
  return sanitized ? `${message}\nApp Server stderr:\n${sanitized}` : message;
}
