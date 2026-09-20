import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { toConversationInputEvent } from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";
import type { OperationUpdate } from "../src/conversation-core/index.js";
import { ProviderProxy } from "../src/provider-proxy/index.js";
import { appendDiagnostic, appServerFailure, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";
import { completedResponseEvent } from "./support/real-app-server-supervised-fixtures.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;

contractSuite("real supervised App Server tools", () => {
    it("preserves CUA titles through real MCP Item lifecycle notifications", async () => {
      const testRuntime = mkdtempSync(join(tmpdir(), "codex-cua-contract-"));
      const codexHome = join(testRuntime, "home");
      const title = "检查空白页面";
      const operations: OperationUpdate[] = [];
      let requestCount = 0;
      let completed = false;
      const apiServer = createServer((request, response) => {
        request.resume();
        if (request.method !== "POST" || request.url !== "/responses") {
          response.writeHead(404).end();
          return;
        }
        const id = `cua-response-${++requestCount}`;
        const item = requestCount === 1
          ? {
              type: "function_call", call_id: "cua-call", namespace: "mcp__cua_repl", name: "js",
              arguments: JSON.stringify({ title, code: "fixture only; not executed" }),
            }
          : {
              type: "message", role: "assistant", id: "cua-answer",
              content: [{ type: "output_text", text: "done" }],
            };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id } },
          { type: "response.output_item.done", item },
          completedResponseEvent(id),
        ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      });
      let client: CodexAppServerClient | undefined;
      let removeNotification: (() => void) | undefined;
      try {
        await new Promise<void>((resolveListen) => apiServer.listen(0, "127.0.0.1", resolveListen));
        const address = apiServer.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture address");
        mkdirSync(codexHome, { mode: 0o700 });
        const mcpPath = join(testRuntime, "mcp.mjs");
        writeFileSync(mcpPath, `
          import { createInterface } from 'node:readline';
          createInterface({input:process.stdin}).on('line', line => {
            const m=JSON.parse(line);
            if (m.id === undefined) return;
            let result;
            if (m.method === 'initialize') result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'cua-fixture',version:'1'}};
            else if (m.method === 'tools/list') result={tools:[{name:'js',description:'Read a fixture',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{title:{type:'string'},code:{type:'string'}}}}]};
            else if (m.method === 'tools/call') result={content:[{type:'text',text:'fixture result'}],isError:false};
            else result={};
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
          });
        `);
        writeFileSync(join(codexHome, "config.toml"), [
          'model = "cua-contract-model"', 'model_provider = "cua-contract"',
          '[mcp_servers.cua_repl]', `command = ${JSON.stringify(process.execPath)}`,
          `args = [${JSON.stringify(mcpPath)}]`,
          '[model_providers.cua-contract]', 'name = "CUA contract"',
          `base_url = "http://127.0.0.1:${address.port}"`, 'wire_api = "responses"',
          'requires_openai_auth = false', 'supports_websockets = false',
        ].join("\n"));
        client = new CodexAppServerClient(new JsonRpcClient(new StdioTransport({
          codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: testRuntime,
          environment: { ...process.env, CODEX_HOME: codexHome },
        })), { sandbox: "read-only" });
        await client.connect();
        const { thread } = await client.startThread(testRuntime, { ephemeral: true, approvalPolicy: "never" });
        removeNotification = client.onNotification((notification) => {
          const event = toConversationInputEvent(notification);
          if (event?.type === "item.operation.updated" && event.threadId === thread.id) {
            operations.push(event.operation);
          }
          if (event?.type === "turn.completed" && event.threadId === thread.id) completed = true;
        });
        await client.startTurn(thread.id, [{ type: "text", text: "Run the fixture." }], "codex_connect:cua-contract", testRuntime);
        await waitFor(() => completed, 15_000);
        expect(requestCount).toBe(2);
        expect(operations).toEqual([
          expect.objectContaining({ kind: "mcpTool", action: "computerUse", status: "running", detail: `${title} · cua_repl.js` }),
          expect.objectContaining({ kind: "mcpTool", action: "computerUse", status: "completed", detail: `${title} · cua_repl.js` }),
        ]);
        expect(JSON.stringify(operations)).not.toContain("fixture only");
      } finally {
        removeNotification?.();
        await client?.close();
        await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
        rmSync(testRuntime, { recursive: true, force: true });
      }
    }, 30_000);

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
      let releaseChildResponse!: () => void;
      const parentCompleted = new Promise<void>((resolveCompleted) => {
        releaseChildResponse = resolveCompleted;
      });
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
          const sendResponse = () => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of events) {
              response.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            response.end();
          };
          if (!body.includes(spawnCallId) && body.includes(childPrompt)) {
            // Exercise late child completion deterministically, not by model-response timing.
            void parentCompleted.then(sendResponse);
          } else {
            sendResponse();
          }
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
            releaseChildResponse();
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
        releaseChildResponse();
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
});
