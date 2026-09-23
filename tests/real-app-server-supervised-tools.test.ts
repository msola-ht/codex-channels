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
import type { ThreadStartResponse, ThreadTurnsListResponse, TurnStartResponse } from "../src/codex-protocol/index.js";
import type { OperationUpdate } from "../src/conversation-core/index.js";
import { ProviderProxy } from "../src/provider-proxy/index.js";
import { appendDiagnostic, appServerFailure, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";
import { completedResponseEvent } from "./support/real-app-server-supervised-fixtures.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;

contractSuite("real supervised App Server tools", () => {
    it("forwards image fileId, preserves history and reports backend rejection", async () => {
      const directory = mkdtempSync(join(tmpdir(), "codex-image-reference-contract-"));
      const codexHome = join(directory, "home");
      const bodies: unknown[] = [];
      const completions: { turnId: string; status: string }[] = [];
      let rejectImage = false;
      const apiServer = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/responses") {
            response.writeHead(404).end();
            return;
          }
          bodies.push(JSON.parse(Buffer.concat(chunks).toString()) as unknown);
          if (rejectImage) {
            response.writeHead(400, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { code: "invalid_image", message: "Fixture file is unavailable" } }));
            return;
          }
          const id = "image-reference-response";
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [
            { type: "response.created", response: { id } },
            { type: "response.output_item.done", item: { type: "message", role: "assistant", id: "fixture-answer",
              content: [{ type: "output_text", text: "Transport fixture; no image recognition" }] } },
            completedResponseEvent(id),
          ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
          response.end();
        });
      });
      let rpc: JsonRpcClient | undefined;
      let removeNotification: (() => void) | undefined;
      try {
        await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
        const address = apiServer.address();
        if (!address || typeof address === "string") throw new Error("Missing image fixture address");
        mkdirSync(codexHome, { mode: 0o700 });
        const catalog = join(codexHome, "models.json");
        writeFileSync(catalog, JSON.stringify({ models: [{
          slug: "image-contract", display_name: "Image fixture", description: "Offline image fixture",
          context_window: 200_000, default_reasoning_level: "high",
          supported_reasoning_levels: [{ effort: "high", description: "Fixture" }],
          shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 1,
          availability_nux: null, upgrade: null, base_instructions: "Do not call tools.",
          support_verbosity: true, default_verbosity: "low", apply_patch_tool_type: "freeform",
          truncation_policy: { mode: "tokens", limit: 10_000 }, supports_parallel_tool_calls: false,
          experimental_supported_tools: [], input_modalities: ["text", "image"],
        }] }));
        writeFileSync(join(codexHome, "config.toml"), [
          'model = "image-contract"', 'model_provider = "image-contract"', `model_catalog_json = ${JSON.stringify(catalog)}`,
          '[model_providers.image-contract]', 'name = "Image fixture"', `base_url = "http://127.0.0.1:${address.port}"`,
          'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
          'request_max_retries = 0', 'stream_max_retries = 0',
        ].join("\n"));
        rpc = new JsonRpcClient(new StdioTransport({
          codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: directory,
          environment: { PATH: process.env.PATH, CODEX_HOME: codexHome },
        }));
        rpc.setServerRequestHandler(async () => { throw new Error("Unexpected image contract Server Request"); });
        await rpc.connect();
        removeNotification = rpc.onNotification((notification) => {
          if (notification.method === "turn/completed") {
            const params = notification.params as { turn: { id: string; status: string } };
            completions.push({ turnId: params.turn.id, status: params.turn.status });
          }
        });
        const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: {
          cwd: directory, sandbox: "read-only", approvalPolicy: "never", historyMode: "paginated",
        } });
        // Exercise generated protocol directly: Gateway intentionally has no fileId input port yet.
        const input = [{ type: "image" as const, fileId: "file_contract_fixture", detail: "high" as const }];
        const accepted = await rpc.request<TurnStartResponse>({ method: "turn/start", params: { threadId: thread.id, input: [...input] } });
        await waitFor(() => completions.some(turn => turn.turnId === accepted.turn.id), 15_000);
        expect(completions).toContainEqual({ turnId: accepted.turn.id, status: "completed" });
        expect(bodies).toHaveLength(1);
        expect(bodies[0]).toMatchObject({ input: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: expect.arrayContaining([
            { type: "input_image", file_id: "file_contract_fixture", detail: "high" },
          ]) }),
        ]) });
        const history = await rpc.request<ThreadTurnsListResponse>({ method: "thread/turns/list", params: {
          threadId: thread.id, itemsView: "full", limit: 10,
        } });
        expect(history.data.flatMap(turn => turn.items)).toContainEqual(expect.objectContaining({
          type: "userMessage", content: expect.arrayContaining([...input]),
        }));
        const followup = await rpc.request<TurnStartResponse>({ method: "turn/start", params: {
          threadId: thread.id, input: [{ type: "text", text: "Continue discussing the previous image.", text_elements: [] }],
        } });
        await waitFor(() => completions.some(turn => turn.turnId === followup.turn.id), 15_000);
        expect(completions).toContainEqual({ turnId: followup.turn.id, status: "completed" });
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toMatchObject({ input: expect.arrayContaining([
          expect.objectContaining({ role: "user", content: expect.arrayContaining([
            { type: "input_image", file_id: "file_contract_fixture", detail: "high" },
          ]) }),
        ]) });
        const followupBody = bodies[1] as { input: { content?: { type: string; file_id?: string; image_url?: string }[] }[] };
        const followupImages = followupBody.input.flatMap(item => item.content ?? [])
          .filter(item => item.type === "input_image");
        expect(followupImages).toEqual([{ type: "input_image", file_id: "file_contract_fixture", detail: "high" }]);
        rejectImage = true;
        const rejected = await rpc.request<TurnStartResponse>({ method: "turn/start", params: { threadId: thread.id, input: [...input] } });
        await waitFor(() => completions.some(turn => turn.turnId === rejected.turn.id), 15_000);
        expect(completions).toContainEqual({ turnId: rejected.turn.id, status: "failed" });
        expect(bodies).toHaveLength(3);
        await rpc.request({ method: "thread/unsubscribe", params: { threadId: thread.id } });
      } finally {
        removeNotification?.();
        await rpc?.close();
        apiServer.closeAllConnections();
        await new Promise<void>((resolve) => apiServer.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    }, 45_000);


    it("delivers async questions without a Server Request and accepts ordinary steer and next-Turn answers", async () => {
      const directory = mkdtempSync(join(tmpdir(), "codex-async-contract-"));
      const codexHome = join(directory, "home");
      let count = 0;
      let completeCount = 0;
      let serverRequestCount = 0;
      let releaseResponse: (() => void) | undefined;
      const notifications: ReturnType<typeof toConversationInputEvent>[] = [];
      const bodies: string[] = [];
      const apiServer = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          if (request.method !== "POST" || request.url !== "/responses") {
            response.writeHead(404).end();
            return;
          }
          bodies.push(Buffer.concat(chunks).toString());
          const number = ++count;
          const id = `async-response-${number}`;
          const send = () => {
            const item = number === 1
              ? { type: "function_call", call_id: "async-question-call", namespace: "functions", name: "request_user_input_async",
                  arguments: JSON.stringify({ questions: [{ title: "Choose a scope", options: ["Small", "Full"] }, { title: "Any details?" }] }) }
              : { type: "message", role: "assistant", id: `answer-${number}`, content: [{ type: "output_text", text: "done" }] };
            response.writeHead(200, { "content-type": "text/event-stream" });
            for (const event of [{ type: "response.created", response: { id } }, { type: "response.output_item.done", item }, completedResponseEvent(id)]) {
              response.write(`data: ${JSON.stringify(event)}\n\n`);
            }
            response.end();
          };
          if (number === 2) releaseResponse = send;
          else send();
        });
      });
      let client: CodexAppServerClient | undefined;
      let removeNotification: (() => void) | undefined;
      try {
        await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
        const address = apiServer.address();
        if (!address || typeof address === "string") throw new Error("Missing fixture address");
        mkdirSync(codexHome, { mode: 0o700 });
        const catalog = join(codexHome, "models.json");
        writeFileSync(catalog, JSON.stringify({ models: [{
          slug: "async-contract", display_name: "Async fixture", description: "Async fixture",
          context_window: 200_000, default_reasoning_level: "high",
          supported_reasoning_levels: [{ effort: "high", description: "Fixture" }],
          shell_type: "shell_command", visibility: "list", supported_in_api: true, priority: 1,
          availability_nux: null, upgrade: null, base_instructions: "You are a coding agent.",
          support_verbosity: true, default_verbosity: "low", apply_patch_tool_type: "freeform",
          truncation_policy: { mode: "tokens", limit: 10_000 }, supports_parallel_tool_calls: true,
          experimental_supported_tools: ["request_user_input_async"],
        }] }));
        writeFileSync(join(codexHome, "config.toml"), [
          'model = "async-contract"', 'model_provider = "async-contract"', `model_catalog_json = ${JSON.stringify(catalog)}`,
          '[model_providers.async-contract]', 'name = "Async fixture"', `base_url = "http://127.0.0.1:${address.port}"`,
          'wire_api = "responses"', 'requires_openai_auth = false', 'supports_websockets = false',
        ].join("\n"));
        const rpc = new JsonRpcClient(new StdioTransport({
          codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: directory,
          environment: { ...process.env, CODEX_HOME: codexHome },
        }));
        rpc.setServerRequestHandler(async () => {
          serverRequestCount++;
          throw new Error("Unexpected Server Request in async question contract");
        });
        client = new CodexAppServerClient(rpc, { sandbox: "read-only" });
        await client.connect();
        const { thread } = await client.startThread(directory, { ephemeral: true, approvalPolicy: "never" });
        removeNotification = client.onNotification((notification) => {
          const event = toConversationInputEvent(notification);
          notifications.push(event);
          if (event?.type === "turn.completed") completeCount++;
        });
        const turn = await client.startTurn(thread.id, [{ type: "text", text: "Ask while working" }], "codex_connect:async-start", directory);
        await waitFor(() => releaseResponse !== undefined, 15_000);
        expect(completeCount).toBe(0);
        expect(notifications).toContainEqual(expect.objectContaining({
          type: "item.agentMessage.completed", itemId: "async-question-call", delivery: "async",
          questions: [{ title: "Choose a scope", options: ["Small", "Full"] }, { title: "Any details?", options: [] }],
        }));
        await client.steerTurn(thread.id, turn.turnId, [{ type: "text", text: "Active answer: Small" }], "codex_connect:async-steer");
        releaseResponse!();
        releaseResponse = undefined;
        await waitFor(() => completeCount === 1, 15_000);
        await client.startTurn(thread.id, [{ type: "text", text: "Idle answer: with details" }], "codex_connect:async-next", directory);
        await waitFor(() => completeCount === 2, 15_000);
        expect(bodies.join("\n")).toContain("Active answer: Small");
        expect(bodies.join("\n")).toContain("Idle answer: with details");
        expect(serverRequestCount).toBe(0);
      } finally {
        releaseResponse?.();
        removeNotification?.();
        await client?.close();
        await new Promise<void>((resolve) => apiServer.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    }, 45_000);

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

    it("inherits parent Provider credentials with native role model overrides and attributes completion to the parent Turn", async () => {
      const testRuntime = mkdtempSync(join(tmpdir(), "codex-subagent-completion-contract-"));
      const codexHome = join(testRuntime, "codex-home");
      const workspace = join(testRuntime, "workspace");
      const socketPath = join(testRuntime, "codex-app-server.sock");
      const parentPrompt = "Spawn the completion contract worker.";
      const childPrompt = "Complete the child contract task.";
      const spawnCallId = "spawn-completion-contract-worker";
      let responseSequence = 0;
      let childRequest: { model?: string; reasoning?: { effort?: string } } | undefined;
      let childAuthorization: string | undefined;
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
                      agent_type: "external",
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
            childRequest = JSON.parse(body) as typeof childRequest;
            childAuthorization = request.headers.authorization;
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
      const rolePath = join(codexHome, "sf-agent.config.toml");
      writeFileSync(rolePath, 'model = "gpt-5.6-terra"\nmodel_reasoning_effort = "low"\n', { mode: 0o600 });
      writeFileSync(join(codexHome, "config.toml"), [
        'model = "subagent-contract-model"',
        'model_provider = "subagent-contract"',
        "",
        "[features]",
        "multi_agent_v2 = true",
        "",
        "[agents.external]",
        'description = "Native role contract"',
        `config_file = ${JSON.stringify(rolePath)}`,
        "",
        "[model_providers.subagent-contract]",
        'name = "Subagent Contract Provider"',
        `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
        'wire_api = "responses"',
        "requires_openai_auth = false",
        "supports_websockets = false",
        'experimental_bearer_token = "parent-contract-key"',
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
        const started = await client.startThread(workspace);
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
        expect(childRequest).toMatchObject({ model: "gpt-5.6-terra", reasoning: { effort: "low" } });
        expect(childAuthorization).toBe("Bearer parent-contract-key");
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
        const descendants = await client.listThreadDescendants(threadId, false);
        expect(descendants).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: spawned?.agentThreadId, parentThreadId: threadId }),
        ]));
        await client.archiveThread(threadId);
        expect(await client.listThreadDescendants(threadId, false)).toEqual([]);
        expect(await client.listThreadDescendants(threadId, true)).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: spawned?.agentThreadId, parentThreadId: threadId }),
        ]));
        expect(await client.listThreads(workspace, { archived: true, fullScan: true }))
          .toEqual(expect.arrayContaining([expect.objectContaining({ id: threadId })]));
        parentTurnId = undefined;
        threadId = undefined;
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
