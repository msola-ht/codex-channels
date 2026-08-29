import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import pino from "pino";
import { parse } from "smol-toml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
import { updateCodexUserConfig } from "../scripts/codex-user-config.mjs";
import {
  loadCodexUserSettings,
  updateCodexUserSetting,
} from "../scripts/codex-user-settings-management.mjs";
import type { ApprovalRequest } from "../src/approval/index.js";
import type { McpRuntimeStatus } from "../src/application/index.js";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import {
  handleApprovalServerRequest,
  toConversationInputEvent,
  toThreadQueueChangedEvent,
  toThreadStateEvent,
} from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";
import { ProviderProxy } from "../src/provider-proxy/index.js";

const run = process.env.RUN_CODEX_INTEGRATION === "1";
const suite = run ? describe : describe.skip;
const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;
const deepseekCatalogPath = process.env.CODEX_DEEPSEEK_MODEL_CATALOG;
const deepseekCatalogContractTest = runContract ? it : it.skip;
const archiveFixtureThreadId = process.env.CODEX_ARCHIVE_FIXTURE_THREAD_ID;
const archiveTest = run && archiveFixtureThreadId ? it : it.skip;
const resumeFixtureThreadId = process.env.CODEX_RESUME_FIXTURE_THREAD_ID;
const resumeTest = run && resumeFixtureThreadId ? it : it.skip;
const forkTest = run && resumeFixtureThreadId ? it : it.skip;

describe("real App Server test process cleanup", () => {
  it("stops descendant processes before temporary directory cleanup", async () => {
    const runtimeRoot = resolve(".runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const testRuntime = mkdtempSync(join(runtimeRoot, "process-tree-"));
    const markerPath = join(testRuntime, "descendant-writes");
    const descendantSource = [
      'const { appendFileSync } = require("node:fs");',
      "const markerPath = process.argv[1];",
      'appendFileSync(markerPath, "x");',
      'const interval = setInterval(() => appendFileSync(markerPath, "x"), 25);',
      "setTimeout(() => { clearInterval(interval); process.exit(0); }, 2_000);",
    ].join("\n");
    const parentSource = [
      'const { spawn } = require("node:child_process");',
      `spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, process.argv[1]], {`,
      '  stdio: "ignore",',
      "});",
      "setInterval(() => undefined, 1_000);",
    ].join("\n");
    const parent = spawn(process.execPath, ["-e", parentSource, markerPath], {
      detached: process.platform !== "win32",
      stdio: "ignore",
    });

    try {
      await waitFor(() => existsSync(markerPath), 1_000);
      await stopDetachedTestProcess(parent, 1_000);
      const sizeAfterStop = statSync(markerPath).size;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
      expect(statSync(markerPath).size).toBe(sizeAfterStop);
    } finally {
      signalTestProcessTree(parent, "SIGKILL");
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
});

suite("real Codex App Server over Unix WebSocket", () => {
  const workdir = process.cwd();
  const runtimeRoot = resolve(".runtime");
  let testRuntime: string;
  let socketPath: string;
  let processHandle: ChildProcess;
  let client: CodexAppServerClient;
  let peerRpc: JsonRpcClient;
  let peerClient: CodexAppServerClient;
  let upstreamUserAgent = "";
  let appServerStderr = "";

  beforeAll(async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    testRuntime = mkdtempSync(join(runtimeRoot, "integration-"));
    socketPath = join(testRuntime, "app-server.sock");
    processHandle = spawn("codex", ["app-server", "--listen", `unix://${socketPath}`], {
      cwd: workdir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      appServerStderr = appendDiagnostic(appServerStderr, chunk);
    });
    await waitFor(
      () => existsSync(socketPath),
      10_000,
      () => processHandle.exitCode === null
        ? undefined
        : new Error(appServerFailure("Codex App Server 在创建 Unix Socket 前退出", appServerStderr)),
    );
    const transport = new UnixWebSocketTransport(socketPath);
    client = new CodexAppServerClient(new JsonRpcClient(transport), {
      sandbox: "read-only",
    });
    peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
    peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
    const initialized = await client.connect();
    await peerClient.connect();
    upstreamUserAgent = initialized.userAgent;
  }, 15_000);

  afterAll(async () => {
    await peerClient?.close();
    await client?.close();
    if (processHandle?.exitCode === null) {
      processHandle.kill("SIGTERM");
      await new Promise((resolveExit) => processHandle.once("exit", resolveExit));
    }
    if (testRuntime) {
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("lists native threads without starting a turn", async () => {
    const threads = await client.listThreads(workdir);
    const archived = await client.listThreads(workdir, { archived: true });
    expect(Array.isArray(threads)).toBe(true);
    expect(Array.isArray(archived)).toBe(true);
    pino({ enabled: false }).info({ count: threads.length });
  });

  it("accepts dynamic tool registration on a fresh Thread", async () => {
    const started = await client.startThread(workdir, {
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
    try {
      expect(started.thread.id).toBeTruthy();
    } finally {
      await client.unsubscribeThread(started.thread.id).catch(() => undefined);
    }
  });

  it("preserves and recovers an automation Thread through a fresh Gateway connection", async () => {
    const started = await client.startThread(workdir, { threadSource: "automation" });
    let completed = false;
    let turnId: string | undefined;
    let recoveryClient: CodexAppServerClient | undefined;
    const removeNotification = client.onNotification((notification) => {
      const event = toConversationInputEvent(notification);
      if (event?.type === "turn.completed" && event.threadId === started.thread.id) {
        completed = true;
      }
    });
    try {
      expect(started.thread.source).toBe("automation");
      expect(started.thread.historyMode).toBe("paginated");
      const turn = await client.startTurn(
        started.thread.id,
        [{ type: "text", text: "Reply with one short word." }],
        "codex_connect:automation-source-contract",
        workdir,
      );
      turnId = turn.turnId;
      await waitFor(() => completed, 30_000);
      await client.unsubscribeThread(started.thread.id);
      recoveryClient = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await recoveryClient.connect();
      const resumed = await recoveryClient.resumeThread(started.thread.id, workdir);
      const history = await recoveryClient.listThreadTurns(started.thread.id, { limit: 25 });
      expect(resumed.thread.source).toBe("automation");
      expect(history.turns.find((candidate) => candidate.id === turnId)?.status)
        .toBe("completed");
    } finally {
      removeNotification();
      await recoveryClient?.unsubscribeThread(started.thread.id).catch(() => undefined);
      await recoveryClient?.deleteThread(started.thread.id).catch(() => undefined);
      await recoveryClient?.close().catch(() => undefined);
      if (recoveryClient === undefined) {
        await client.unsubscribeThread(started.thread.id).catch(() => undefined);
        await client.deleteThread(started.thread.id).catch(() => undefined);
      }
    }
  });

  it("reports the upstream user agent used by Codex", () => {
    expect(upstreamUserAgent).toContain("codex_connect/");
  });

  it("reads account rate-limit snapshots without starting a turn", async () => {
    const result = await client.accountRateLimits();

    expect(result.limits.length).toBeGreaterThan(0);
    expect(result.limits[0]?.primary === null
      || typeof result.limits[0]?.primary?.usedPercent === "number").toBe(true);
  });

  it("reads the current account's estimate for one exact Thread", async () => {
    const started = await client.startThread(workdir);
    try {
      const result = await client.accountThreadUsage(started.thread.id);

      expect(result.kind === "unavailable"
        || (result.kind === "available" && result.threadId === started.thread.id)).toBe(true);
      await expect(client.accountThreadUsage("not-a-thread-id"))
        .rejects.toThrow(/invalid thread id/iu);
    } finally {
      await client.unsubscribeThread(started.thread.id).catch(() => undefined);
      await client.deleteThread(started.thread.id);
    }
  });

  it("lists models with their supported reasoning efforts", async () => {
    const models = await client.listModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.supportedReasoningEfforts.length > 0)).toBe(true);
  });

  it("lists directly installed Skills through the stable query result", async () => {
    const skills = await client.listSkills(workdir);

    expect(Array.isArray(skills)).toBe(true);
    expect(skills.every((skill) =>
      typeof skill.name === "string" && typeof skill.description === "string")).toBe(true);
  });

  it("lists installed Plugins without loading remote catalog entries", async () => {
    const catalog = await client.listPlugins(workdir);

    expect(Array.isArray(catalog.plugins)).toBe(true);
    expect(catalog.loadErrorCount).toBe(0);
    expect(catalog.plugins.every((plugin) =>
      typeof plugin.id === "string"
      && typeof plugin.name === "string"
      && typeof plugin.enabled === "boolean"
      && typeof plugin.available === "boolean")).toBe(true);
  });

  it("broadcasts and exposes a loaded temporary thread across two clients without running a model turn", async () => {
    let observedThreadId: string | undefined;
    const removePeerNotification = peerClient.onNotification((notification) => {
      if (notification.method !== "thread/started") {
        return;
      }
      const params = typeof notification.params === "object" && notification.params !== null
        ? notification.params as Record<string, unknown>
        : {};
      const thread = typeof params.thread === "object" && params.thread !== null
        ? params.thread as Record<string, unknown>
        : {};
      if (typeof thread.id === "string") {
        observedThreadId = thread.id;
      }
    });
    const started = await client.startThread(workdir);
    try {
      await waitFor(() => observedThreadId === started.thread.id, 2_000);
      const loaded = await peerRpc.request<{ data: string[] }>({
        method: "thread/loaded/list",
        params: { limit: 100 },
      }, { retryOverload: true });
      await client.unsubscribeThread(started.thread.id);

      expect(started.thread.id).toBeTruthy();
      expect(observedThreadId).toBe(started.thread.id);
      expect(loaded.data).toContain(started.thread.id);
    } finally {
      removePeerNotification();
      await client.unsubscribeThread(started.thread.id).catch(() => undefined);
      await client.deleteThread(started.thread.id);
    }
  });

  resumeTest("reads and resumes an explicitly selected idle fixture thread from both clients", async () => {
    const threadId = resumeFixtureThreadId!;
    const fixture = await client.readThread(threadId);
    expect(fixture.cwd).toBe(workdir);
    expect(fixture.status.type).not.toBe("active");

    let ownerSubscribed = false;
    let peerSubscribed = false;
    try {
      const ownerResumed = await client.resumeThread(threadId, workdir);
      ownerSubscribed = true;
      const peerRead = await peerClient.readThread(threadId);
      const peerResumed = await peerClient.resumeThread(threadId, workdir);
      peerSubscribed = true;

      expect(ownerResumed.thread.id).toBe(threadId);
      expect(peerRead.id).toBe(threadId);
      expect(peerRead.cwd).toBe(workdir);
      expect(peerResumed.thread.id).toBe(threadId);
    } finally {
      if (peerSubscribed) {
        await peerClient.unsubscribeThread(threadId).catch(() => undefined);
      }
      if (ownerSubscribed) {
        await client.unsubscribeThread(threadId).catch(() => undefined);
      }
    }
  });

  forkTest("forks an idle history thread with explicit provider settings", async () => {
    const source = await client.resumeThread(resumeFixtureThreadId!, workdir);
    let forkedId: string | undefined;
    try {
      const forked = await client.forkThread(source.thread.id, workdir, {
        model: source.model,
        modelProvider: source.modelProvider ?? "openai",
      });
      forkedId = forked.thread.id;

      expect(forked.thread.id).not.toBe(source.thread.id);
      expect(forked.model).toBe(source.model);
      expect(forked.modelProvider).toBe(source.modelProvider ?? "openai");
    } finally {
      if (forkedId) {
        await client.unsubscribeThread(forkedId).catch(() => undefined);
        await client.deleteThread(forkedId).catch(() => undefined);
      }
      await client.unsubscribeThread(source.thread.id).catch(() => undefined);
    }
  });

  archiveTest("archives and restores an explicitly selected idle fixture thread", async () => {
    const threadId = archiveFixtureThreadId!;
    const fixture = await client.readThread(threadId);
    expect(fixture.cwd).toBe(workdir);
    expect(fixture.status.type).not.toBe("active");

    let archived = false;
    try {
      await client.archiveThread(threadId);
      archived = true;
      const archivedThreads = await client.listThreads(workdir, { archived: true });
      expect(archivedThreads.some((thread) => thread.id === threadId)).toBe(true);

      const restored = await client.unarchiveThread(threadId);
      archived = false;
      expect(restored.id).toBe(threadId);
    } finally {
      if (archived) {
        await client.unarchiveThread(threadId);
      }
    }
  });
});

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

  it("runs the native Queue capacity, paging, dispatch and restart contract", async () => {
    const testRuntime = mkdtempSync(join(tmpdir(), "codex-queue-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const socketPath = join(testRuntime, "codex-app-server.sock");
    const apiServerResponses = new Map<ServerResponse, string>();
    const responseIds: string[] = [];
    const apiServer = createServer((request, response) => {
      if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          object: "list",
          data: [{ id: "queue-contract-model", object: "model", owned_by: "contract" }],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/responses") {
        request.resume();
        response.writeHead(200, { "content-type": "text/event-stream" });
        const responseId = `queue-contract-response-${responseIds.length + 1}`;
        responseIds.push(responseId);
        response.write(`data: ${JSON.stringify({
          type: "response.created",
          response: { id: responseId },
        })}\n\n`);
        apiServerResponses.set(response, responseId);
        response.once("close", () => apiServerResponses.delete(response));
        return;
      }
      request.resume();
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "queue contract fixture endpoint" } }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("Queue 合同无法创建本机 Responses 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), [
      'model = "queue-contract-model"',
      'model_provider = "queue-contract"',
      "",
      "[model_providers.queue-contract]",
      'name = "Queue Contract Provider"',
      `base_url = "http://127.0.0.1:${apiAddress.port}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "",
    ].join("\n"), { mode: 0o600 });

    let stderr = "";
    const startProcess = (): ChildProcess => {
      const child = spawn(
        process.env.CODEX_BINARY ?? "codex",
        ["app-server", "--listen", `unix://${socketPath}`],
        {
          cwd: process.cwd(),
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"],
          detached: process.platform !== "win32",
        },
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = appendDiagnostic(stderr, chunk);
      });
      return child;
    };
    let processHandle = startProcess();
    let client: CodexAppServerClient | undefined;
    let threadId: string | undefined;
    let coldThreadId: string | undefined;
    let activeTurnId: string | undefined;
    let removeNotification: (() => void) | undefined;
    const changedThreadIds: string[] = [];
    const startedTurnIds = new Set<string>();
    const completedTurnIds = new Set<string>();
    const attachNotifications = (): void => {
      removeNotification?.();
      removeNotification = client?.onNotification((notification) => {
        const changed = toThreadQueueChangedEvent(notification);
        if (changed) changedThreadIds.push(changed.threadId);
        const event = toConversationInputEvent(notification);
        if (!event || !("threadId" in event)) return;
        if (event.type === "turn.started") startedTurnIds.add(event.turnId);
        if (event.type === "turn.completed") completedTurnIds.add(event.turnId);
      });
    };
    const completeResponse = (responseId: string): void => {
      const response = [...apiServerResponses.entries()]
        .find(([, id]) => id === responseId)?.[0];
      if (!response) {
        throw new Error(`找不到待完成的 Responses 夹具：${responseId}`);
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
    try {
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle.exitCode === null
          ? undefined
          : new Error(appServerFailure("Queue 合同 App Server 启动失败", stderr)),
      );
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "workspace-write" },
      );
      await client.connect();
      const started = await client.startThread(workspace);
      threadId = started.thread.id;
      attachNotifications();
      try {
        const turn = await client.startTurn(
          threadId,
          [{ type: "text", text: "Hold this controlled turn open for Queue contract." }],
          "codex_connect:queue-contract",
          workspace,
        );
        activeTurnId = turn.turnId;
        await waitFor(() => responseIds.length >= 1, 5_000);

        const queuedItems = [];
        for (let index = 0; index < 100; index += 1) {
          queuedItems.push(await client.addQueueItem(
            threadId,
            `queue contract ${index + 1}`,
            `codex_connect:queue-contract-${index + 1}`,
          ));
        }
        await expect(client.addQueueItem(
          threadId,
          "queue contract 101",
          "codex_connect:queue-contract-101",
        )).rejects.toThrow("100");
        const full = await client.listQueue(threadId, { limit: 100 });
        expect(full.nextCursor).toBeNull();
        expect(full.items).toHaveLength(100);
        const pages = [];
        let cursor: string | null = null;
        do {
          const page = await client.listQueue(threadId, { cursor, limit: 25 });
          pages.push(page);
          cursor = page.nextCursor;
        } while (cursor !== null);
        expect(pages).toHaveLength(4);
        expect(pages.flatMap((page) => page.items)).toHaveLength(100);
        expect(pages.map((page) => page.items.length)).toEqual([25, 25, 25, 25]);

        await expect(client.startQueueItem(threadId, queuedItems[0]!.id))
          .rejects.toThrow("active or pending turn");
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(100);

        await client.interruptTurn(threadId, activeTurnId);
        await waitFor(() => completedTurnIds.has(activeTurnId!), 10_000);
        activeTurnId = undefined;
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(100);

        const specified = queuedItems[1]!;
        const specifiedTurn = await client.startQueueItem(threadId, specified.id);
        await waitFor(() => startedTurnIds.has(specifiedTurn.turnId), 10_000);
        await client.interruptTurn(threadId, specifiedTurn.turnId);
        await waitFor(() => completedTurnIds.has(specifiedTurn.turnId), 10_000);
        expect((await client.listQueue(threadId, { limit: 100 })).items)
          .toHaveLength(99);

        const beforeReorder = await client.listQueue(threadId, { limit: 100 });
        const first = beforeReorder.items[0]!;
        expect((await client.updateQueueItem(threadId, first.id, "queue contract edited")).id)
          .toBe(first.id);
        await client.reorderQueue(threadId, [
          ...beforeReorder.items.slice(1).map((item) => item.id),
          first.id,
        ]);
        expect(await client.deleteQueueItem(threadId, first.id)).toEqual({ deleted: true });

        const ordinaryResponseIndex = responseIds.length;
        const ordinary = await client.startTurn(
          threadId,
          [{ type: "text", text: "Complete this ordinary turn and dispatch Queue." }],
          "codex_connect:queue-contract-ordinary",
          workspace,
        );
        await waitFor(() => responseIds.length > ordinaryResponseIndex, 5_000);
        completeResponse(responseIds[ordinaryResponseIndex]!);
        await waitFor(() => completedTurnIds.has(ordinary.turnId), 10_000);
        await waitFor(
          () => [...startedTurnIds].some((id) => id !== turn.turnId && id !== specifiedTurn.turnId
            && id !== ordinary.turnId),
          10_000,
        );
        const autoTurnId = [...startedTurnIds].find((id) => id !== turn.turnId
          && id !== specifiedTurn.turnId && id !== ordinary.turnId);
        expect(autoTurnId).toBeDefined();
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(97);
        await client.interruptTurn(threadId, autoTurnId!);
        await waitFor(() => completedTurnIds.has(autoTurnId!), 10_000);

        const persistedQueuedId = (await client.listQueue(threadId, { limit: 100 })).items[0]!.id;
        const coldThread = await client.startThread(workspace);
        coldThreadId = coldThread.thread.id;
        const materializeResponseIndex = responseIds.length;
        const materialize = await client.startTurn(
          coldThreadId,
          [{ type: "text", text: "Materialize a completed cold Queue fixture." }],
          "codex_connect:queue-cold-materialize",
          workspace,
        );
        await waitFor(() => responseIds.length > materializeResponseIndex, 5_000);
        completeResponse(responseIds[materializeResponseIndex]!);
        await waitFor(() => completedTurnIds.has(materialize.turnId), 10_000);
        await client.unsubscribeThread(coldThreadId);

        removeNotification?.();
        removeNotification = undefined;
        await client.unsubscribeThread(threadId);
        await client.close();
        client = undefined;
        await stopDetachedTestProcess(processHandle, 10_000);
        rmSync(socketPath, { force: true });
        processHandle = startProcess();
        await waitFor(
          () => existsSync(socketPath),
          10_000,
          () => processHandle.exitCode === null
            ? undefined
            : new Error(appServerFailure("Queue 冷恢复合同 App Server 启动失败", stderr)),
        );
        client = new CodexAppServerClient(
          new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
          { sandbox: "workspace-write" },
        );
        await client.connect();
        attachNotifications();
        const coldResume = await client.resumeThread(threadId, workspace);
        expect(coldResume.thread.id).toBe(threadId);
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(97);
        const interruptedColdResponseIndex = responseIds.length;
        const interruptedColdTurn = await client.startQueueItem(threadId, persistedQueuedId);
        await waitFor(() => startedTurnIds.has(interruptedColdTurn.turnId), 10_000);
        await waitFor(() => responseIds.length > interruptedColdResponseIndex, 5_000);
        expect((await client.listQueue(threadId, { limit: 100 })).items).toHaveLength(96);
        await client.interruptTurn(threadId, interruptedColdTurn.turnId);
        await waitFor(() => completedTurnIds.has(interruptedColdTurn.turnId), 10_000);

        const coldQueued = await client.addQueueItem(
          coldThreadId,
          "dispatch after a normally completed cold Thread resumes",
          "codex_connect:queue-cold-resume",
        );
        expect((await client.listQueue(coldThreadId, { limit: 100 })).items)
          .toEqual([coldQueued]);
        const startedBeforeColdResume = new Set(startedTurnIds);
        const coldResponseIndex = responseIds.length;
        const resumedColdThread = await client.resumeThread(coldThreadId, workspace);
        expect(resumedColdThread.thread.id).toBe(coldThreadId);
        await waitFor(
          () => [...startedTurnIds].some((id) => !startedBeforeColdResume.has(id)),
          10_000,
        );
        const coldTurnId = [...startedTurnIds].find((id) => !startedBeforeColdResume.has(id));
        expect(coldTurnId).toBeDefined();
        await waitFor(() => responseIds.length > coldResponseIndex, 5_000);
        expect((await client.listQueue(coldThreadId, { limit: 100 })).items).toHaveLength(0);
        await client.interruptTurn(coldThreadId, coldTurnId!);
        await waitFor(() => completedTurnIds.has(coldTurnId!), 10_000);
        await waitFor(() => changedThreadIds.length >= 100, 2_000);
        expect(changedThreadIds.every((id) => id === threadId || id === coldThreadId)).toBe(true);
      } finally {
        removeNotification?.();
        removeNotification = undefined;
      }
    } finally {
      if (activeTurnId && threadId) {
        await client?.interruptTurn(threadId, activeTurnId).catch(() => undefined);
      }
      if (threadId) {
        await client?.unsubscribeThread(threadId).catch(() => undefined);
        await client?.deleteThread(threadId).catch(() => undefined);
      }
      if (coldThreadId) {
        await client?.unsubscribeThread(coldThreadId).catch(() => undefined);
        await client?.deleteThread(coldThreadId).catch(() => undefined);
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

suite("real Codex App Server over stdio", () => {
  let client: CodexAppServerClient;

  afterAll(async () => {
    await client?.close();
  });

  it("uses the same client contract to initialize and list threads", async () => {
    const workdir = process.cwd();
    let appServerStderr = "";
    client = new CodexAppServerClient(
      new JsonRpcClient(new StdioTransport({
        codexBinary: "codex",
        cwd: workdir,
        onStderr: (chunk) => {
          appServerStderr = appendDiagnostic(appServerStderr, chunk);
        },
      })),
      { sandbox: "read-only" },
    );

    let initialized;
    let threads;
    try {
      initialized = await client.connect();
      threads = await client.listThreads(workdir);
    } catch (error) {
      throw new Error(
        appServerFailure(
          error instanceof Error ? error.message : String(error),
          appServerStderr,
        ),
        { cause: error },
      );
    }

    const platformNames: Partial<Record<NodeJS.Platform, string>> = {
      darwin: "macos",
      linux: "linux",
      win32: "windows",
    };
    const expectedPlatform = platformNames[process.platform];
    if (expectedPlatform) {
      expect(initialized.platformOs).toBe(expectedPlatform);
    } else {
      expect(initialized.platformOs).not.toBe("");
    }
    expect(Array.isArray(threads)).toBe(true);
  }, 15_000);
});

contractSuite("isolated Codex App Server state contract", () => {
  const workdir = process.cwd();
  const runtimeRoot = resolve(".runtime");
  let testRuntime: string;
  let codexHome: string;
  let socketPath: string;
  let processHandle: ChildProcess;
  let ownerRpc: JsonRpcClient;
  let ownerClient: CodexAppServerClient;
  let peerRpc: JsonRpcClient;
  let peerClient: CodexAppServerClient;
  let oauthServer: ReturnType<typeof createServer>;
  let oauthBaseUrl: string;
  let runtimeProbeExitFile: string;
  let appServerStderr = "";

  beforeAll(async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    testRuntime = mkdtempSync(join(runtimeRoot, "contract-"));
    codexHome = join(testRuntime, "codex-home");
    socketPath = join(testRuntime, "app-server.sock");
    oauthServer = createServer((request, response) => {
      if (
        request.method === "GET"
        && request.url === "/.well-known/oauth-authorization-server/oauth-mcp"
      ) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          authorization_endpoint: `${oauthBaseUrl}/authorize`,
          token_endpoint: `${oauthBaseUrl}/token`,
          scopes_supported: ["read"],
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        }));
        return;
      }
      if (request.method === "POST" && request.url === "/token") {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          access_token: "contract-access-token",
          token_type: "Bearer",
          expires_in: 3_600,
          refresh_token: "contract-refresh-token",
        }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      oauthServer.once("error", rejectListen);
      oauthServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const oauthAddress = oauthServer.address();
    if (!oauthAddress || typeof oauthAddress === "string") {
      throw new Error("MCP OAuth 合同无法创建本机 HTTP 夹具");
    }
    oauthBaseUrl = `http://127.0.0.1:${oauthAddress.port}`;
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const contractSkillDirectory = join(
      codexHome,
      "skills",
      "contract-skill",
    );
    mkdirSync(contractSkillDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(contractSkillDirectory, "SKILL.md"),
      [
        "---",
        "name: contract-skill",
        "description: Validate structured Skill input.",
        "---",
        "",
        "# Contract Skill",
        "",
        "Reply concisely.",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const pluginMarketplace = join(testRuntime, "contract-marketplace");
    const pluginManifestDirectory = join(
      pluginMarketplace,
      "plugins",
      "contract-plugin",
      ".codex-plugin",
    );
    mkdirSync(join(pluginMarketplace, ".git"), { recursive: true, mode: 0o700 });
    mkdirSync(join(pluginMarketplace, ".agents", "plugins"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(pluginManifestDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(pluginMarketplace, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "contract-marketplace",
        plugins: [{
          name: "contract-plugin",
          source: {
            source: "local",
            path: "./plugins/contract-plugin",
          },
        }],
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(pluginManifestDirectory, "plugin.json"),
      JSON.stringify({
        name: "contract-plugin",
        interface: {
          displayName: "Contract Plugin",
          shortDescription: "Validate structured Plugin mention input.",
        },
      }),
      { mode: 0o600 },
    );
    const installedPluginManifestDirectory = join(
      codexHome,
      "plugins",
      "cache",
      "contract-marketplace",
      "contract-plugin",
      "local",
      ".codex-plugin",
    );
    mkdirSync(installedPluginManifestDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(installedPluginManifestDirectory, "plugin.json"),
      JSON.stringify({ name: "contract-plugin" }),
      { mode: 0o600 },
    );
    const approvalProbe = resolve(
      "tests/fixtures/mcp-tool-approval-server.mjs",
    );
    runtimeProbeExitFile = join(testRuntime, "runtime-probe-exit");
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'mcp_oauth_credentials_store = "file"',
        "",
        "[mcp_servers.approval_probe]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(approvalProbe)}]`,
        "",
        "[mcp_servers.runtime_probe]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify(approvalProbe)}]`,
        "",
        "[mcp_servers.runtime_probe.env]",
        `MCP_TEST_EXIT_FILE = ${JSON.stringify(runtimeProbeExitFile)}`,
        "",
        "[mcp_servers.oauth_probe]",
        `url = ${JSON.stringify(`${oauthBaseUrl}/oauth-mcp`)}`,
        'oauth = { client_id = "contract-oauth-client" }',
        "",
        "[features]",
        "plugins = true",
        "",
        "[marketplaces.contract-marketplace]",
        'source_type = "local"',
        `source = ${JSON.stringify(pluginMarketplace)}`,
        "",
        '[plugins."contract-plugin@contract-marketplace"]',
        "enabled = true",
        "",
        "[model_providers.deepseek]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com/"',
        'wire_api = "responses"',
        'experimental_bearer_token = "sk-contract-placeholder"',
        "",
      ].join("\n"),
    );
    processHandle = spawn(
      process.env.CODEX_BINARY ?? "codex",
      ["app-server", "--listen", `unix://${socketPath}`],
      {
        cwd: workdir,
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "ignore", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    processHandle.stderr?.setEncoding("utf8");
    processHandle.stderr?.on("data", (chunk: string) => {
      appServerStderr = appendDiagnostic(appServerStderr, chunk);
    });
    await waitFor(
      () => existsSync(socketPath),
      10_000,
      () => processHandle.exitCode === null
        ? undefined
        : new Error(appServerFailure("隔离 Codex App Server 在创建 Unix Socket 前退出", appServerStderr)),
    );
    ownerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
    ownerClient = new CodexAppServerClient(
      ownerRpc,
      { sandbox: "read-only" },
    );
    peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
    peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
    await ownerClient.connect();
    await peerClient.connect();
  }, 15_000);

  afterAll(async () => {
    await peerClient?.close();
    await ownerClient?.close();
    await stopDetachedTestProcess(processHandle, 10_000);
    if (oauthServer) {
      await new Promise<void>((resolveClose) => oauthServer.close(() => resolveClose()));
    }
    if (testRuntime) {
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  it("maps the isolated App Server Skill list to stable installed entries", async () => {
    const skills = await ownerClient.listSkills(workdir);

    expect(Array.isArray(skills)).toBe(true);
    expect(skills.every((skill) =>
      typeof skill.name === "string" && typeof skill.description === "string")).toBe(true);
  });

  it("accepts the official Skill marker and structured input together", async () => {
    const skill = await ownerClient.resolveSkill(workdir, "contract-skill");
    expect(skill).toEqual({
      name: "contract-skill",
      path: join(codexHome, "skills", "contract-skill", "SKILL.md"),
    });
    if (!skill) {
      throw new Error("隔离 App Server 未返回 contract-skill");
    }
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [
          { type: "text", text: "$contract-skill 验证结构化调用" },
          {
            type: "skill",
            name: skill.name,
            path: skill.path,
          },
        ],
        "codex_connect:skill-contract",
        workdir,
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
    } finally {
      if (turnId !== undefined) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("maps the isolated App Server MCP list, details, and resources", async () => {
    await expect(ownerClient.reloadMcpServers()).resolves.toBeUndefined();
    const servers = await ownerClient.listMcpServers();

    expect(Array.isArray(servers)).toBe(true);
    expect(servers.every((server) =>
      typeof server.name === "string"
      && server.runtimeStatus === "unknown"
      && (server.pluginId === null || typeof server.pluginId === "string")
      && typeof server.authStatus === "string"
      && Number.isInteger(server.toolCount))).toBe(true);

    const details = await ownerClient.listMcpServerDetails();
    // The isolated fixture exposes config-sourced MCP servers only; the fixed
    // App Server contract has no installed Plugin-backed server to produce a
    // non-null pluginId, so this verifies the nullable boundary only.
    const approvalProbe = details.find((server) => server.name === "approval_probe");
    expect(approvalProbe?.pluginId).toBeNull();
    expect(approvalProbe?.serverVersion).toBe("1.0.0");
    expect(approvalProbe?.tools.some((tool) => tool.name === "approval_probe")).toBe(true);
    const approvalTool = approvalProbe?.tools.find((tool) => tool.name === "approval_probe");
    expect(approvalTool?.access).toBe("writeCapable");
    expect(approvalTool?.description).toHaveLength(2_000);
    expect(approvalTool?.description).toMatch(/^Emit approval details x+$/u);
    expect(approvalProbe?.resources).toContainEqual(expect.objectContaining({
      uri: "contract://status",
      name: "contract-status",
    }));

    await expect(ownerClient.readMcpResource(
      "approval_probe",
      "contract://status",
    )).resolves.toEqual({
      server: "approval_probe",
      requestedUri: "contract://status",
      contents: [{
        kind: "text",
        uri: "contract://status",
        mimeType: "text/plain",
        text: "contract resource ready",
        truncated: false,
      }],
      omittedContentCount: 0,
    });
  }, 15_000);

  it("reports thread MCP runtime failure and reconnect after an explicit reload", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    try {
      await waitForMcpRuntimeStatus(
        ownerClient,
        threadId,
        "runtime_probe",
        "connected",
      );
      writeFileSync(runtimeProbeExitFile, "exit", { mode: 0o600 });
      await waitForMcpRuntimeStatus(
        ownerClient,
        threadId,
        "runtime_probe",
        "failed",
      );

      rmSync(runtimeProbeExitFile, { force: true });
      await ownerClient.reloadMcpServers();
      await waitForMcpRuntimeStatus(
        ownerClient,
        threadId,
        "runtime_probe",
        "connected",
      );
    } finally {
      rmSync(runtimeProbeExitFile, { force: true });
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId).catch(() => undefined);
    }
  }, 20_000);

  it("maps the isolated App Server MCP OAuth completion notification", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let observed: ReturnType<typeof toConversationInputEvent>;
    const removeNotification = ownerClient.onNotification((notification) => {
      const event = toConversationInputEvent(notification);
      if (event?.type === "mcp.oauth.completed" && event.name === "oauth_probe") {
        observed = event;
      }
    });
    try {
      const login = await ownerClient.startMcpOAuthLogin("oauth_probe", threadId);
      const authorizationUrl = new URL(login.authorizationUrl);
      expect(authorizationUrl.origin).toBe(oauthBaseUrl);
      expect(authorizationUrl.searchParams.get("client_id"))
        .toBe("contract-oauth-client");
      const state = authorizationUrl.searchParams.get("state");
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      expect(state).not.toBeNull();
      expect(redirectUri).not.toBeNull();
      if (!state || !redirectUri) {
        throw new Error("MCP OAuth 授权地址缺少 state 或 redirect_uri");
      }
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", "contract-test-code");
      callbackUrl.searchParams.set("state", state);
      const callbackResponse = await fetch(callbackUrl);
      expect(callbackResponse.ok).toBe(true);

      await waitFor(() => observed !== undefined, 10_000);
      expect(observed).toEqual({
        type: "mcp.oauth.completed",
        threadId,
        name: "oauth_probe",
        success: true,
        error: null,
      });
    } finally {
      removeNotification();
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("maps the isolated App Server Plugin list to stable installed entries", async () => {
    const catalog = await ownerClient.listPlugins(workdir);

    expect(Array.isArray(catalog.plugins)).toBe(true);
    expect(catalog.loadErrorCount).toBe(0);
    expect(catalog.plugins.every((plugin) =>
      typeof plugin.id === "string"
      && typeof plugin.name === "string"
      && typeof plugin.enabled === "boolean"
      && typeof plugin.available === "boolean"
      && (plugin.version === null || typeof plugin.version === "string")
      && (plugin.localVersion === null || typeof plugin.localVersion === "string")
      && ["local", "git", "npm", "remote"].includes(plugin.source)
      && (plugin.installedAt === null || Number.isSafeInteger(plugin.installedAt))
      && (plugin.developerName === null || typeof plugin.developerName === "string")
      && (plugin.category === null || typeof plugin.category === "string")
      && plugin.capabilities.every((capability) => typeof capability === "string")
      && ["onInstall", "onUse"].includes(plugin.authPolicy)
      && plugin.eligiblePlanTypes.every((plan) => typeof plan === "string")
      && (plugin.disabledReason === null || typeof plugin.disabledReason === "string")))
      .toBe(true);
  });

  it("accepts an installed Plugin marker and official mention input together", async () => {
    const plugin = await ownerClient.resolvePlugin(
      workdir,
      "contract-plugin@contract-marketplace",
    );
    expect(plugin).toEqual({
      id: "contract-plugin@contract-marketplace",
      name: "contract-plugin",
      displayName: "Contract Plugin",
      path: "plugin://contract-plugin@contract-marketplace",
    });
    if (!plugin) {
      throw new Error("隔离 App Server 未返回 contract-plugin");
    }
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [
          { type: "text", text: "@contract-plugin 验证结构化调用" },
          {
            type: "plugin",
            name: plugin.displayName,
            path: plugin.path,
          },
        ],
        "codex_connect:plugin-contract",
        workdir,
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
    } finally {
      if (turnId !== undefined) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("shares persisted Thread pin state across clients without local storage", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    try {
      await ownerClient.setThreadPinned(threadId, true);

      const peerRead = await peerClient.readThread(threadId);
      expect(peerRead.isPinned).toBe(true);

      await peerClient.setThreadPinned(threadId, false);
      await expect(ownerClient.readThread(threadId)).resolves
        .toMatchObject({ id: threadId, isPinned: false });
    } finally {
      await ownerClient.setThreadPinned(threadId, false).catch(() => undefined);
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("shares stable custom Thread Sections and unassigns members on delete", async () => {
    const first = await ownerClient.startThread(workdir);
    const second = await ownerClient.startThread(workdir);
    const firstThreadId = first.thread.id;
    const secondThreadId = second.thread.id;
    let sectionId: string | undefined;
    try {
      for (const [threadId, text] of [
        [firstThreadId, "Thread Section contract first"],
        [secondThreadId, "Thread Section contract second"],
      ] as const) {
        let userMessageCompleted = false;
        const removeNotification = ownerClient.onNotification((notification) => {
          if (notification.method !== "item/completed") return;
          const params = notification.params as {
            threadId?: unknown;
            item?: { type?: unknown };
          } | undefined;
          if (params?.threadId === threadId && params.item?.type === "userMessage") {
            userMessageCompleted = true;
          }
        });
        let turnId: string | undefined;
        try {
          const turn = await ownerClient.startTurn(
            threadId,
            [{ type: "text", text }],
            "codex_connect:thread-section-contract",
            workdir,
          );
          turnId = turn.turnId;
          await waitFor(() => userMessageCompleted, 2_000);
        } finally {
          removeNotification();
          if (turnId !== undefined) {
            await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
          }
        }
      }

      const created = await ownerClient.createThreadSection(`contract-${Date.now()}`);
      sectionId = created.id;
      const renamed = await ownerClient.renameThreadSection(created.id, "contract-renamed");
      expect(renamed).toMatchObject({ id: created.id, name: "contract-renamed" });
      await ownerClient.moveThreadToSection(firstThreadId, created.id);
      await ownerClient.moveThreadToSection(secondThreadId, created.id, firstThreadId);

      const ordered = await peerClient.listThreads(workdir, {
        fullScan: true,
        sectionId: created.id,
        sortKey: "section_position",
        sortDirection: "asc",
      });
      expect(ordered.map((thread) => thread.id)).toEqual([
        secondThreadId,
        firstThreadId,
      ]);

      await expect(peerClient.listThreadSections()).resolves.toContainEqual({
        id: created.id,
        name: "contract-renamed",
        builtIn: null,
      });
      await expect(peerClient.readThread(firstThreadId)).resolves.toMatchObject({
        section: { id: created.id, name: "contract-renamed" },
        isPinned: false,
      });

      await peerClient.deleteThreadSection(created.id);
      sectionId = undefined;
      await expect(ownerClient.readThread(firstThreadId)).resolves.toMatchObject({
        section: null,
      });
    } finally {
      if (sectionId !== undefined) {
        await ownerClient.deleteThreadSection(sectionId).catch(() => undefined);
      }
      for (const threadId of [firstThreadId, secondThreadId]) {
        await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
        await ownerClient.deleteThread(threadId);
      }
    }
  }, 20_000);

  it("round-trips MCP tool approval metadata through the real App Server", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    let observed: ApprovalRequest | undefined;
    ownerClient.setServerRequestHandler((request) =>
      handleApprovalServerRequest(request, {
        handle: async (approval) => {
          observed = approval;
          return {
            type: "elicitation",
            action: "accept",
            content: null,
            persist: "session",
          };
        },
      }));
    try {
      const response = await ownerRpc.request<{
        content: Array<{ type?: unknown; text?: unknown }>;
        isError?: boolean;
      }>({
        method: "mcpServer/tool/call",
        params: {
          threadId,
          server: "approval_probe",
          tool: "approval_probe",
          arguments: { pull_number: 146 },
        },
      } as never);

      expect(observed).toMatchObject({
        type: "elicitation",
        threadId,
        turnId: null,
        serverName: "approval_probe",
        mode: "form",
        toolApproval: {
          connectorName: "GitHub",
          toolTitle: "Update pull request",
          parameters: [{
            name: "pull_number",
            displayName: "Pull request",
            value: 146,
          }],
          allowSession: true,
          allowAlways: true,
        },
      });
      expect(response.isError).toBe(false);
      expect(JSON.parse(String(response.content[0]?.text))).toEqual({
        action: "accept",
        content: {},
        _meta: { persist: "session" },
      });
    } finally {
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("maps the isolated App Server Permission Profile list to stable options", async () => {
    const profiles = await ownerClient.listPermissionProfiles(workdir);

    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.every((profile) =>
      typeof profile.id === "string"
      && (profile.description === null || typeof profile.description === "string")
      && typeof profile.allowed === "boolean")).toBe(true);
  });

  it("accepts per-workspace sandbox, approval and permission profile overrides", async () => {
    const sandboxed = await ownerClient.startThread(workdir, {
      sandbox: "read-only",
      approvalPolicy: "untrusted",
    });
    const profiled = await ownerClient.startThread(workdir, {
      permissions: ":read-only",
    });

    expect(sandboxed.thread.id).not.toBe(profiled.thread.id);
    await ownerClient.unsubscribeThread(sandboxed.thread.id).catch(() => undefined);
    await ownerClient.unsubscribeThread(profiled.thread.id).catch(() => undefined);
    await ownerClient.deleteThread(sandboxed.thread.id).catch(() => undefined);
    await ownerClient.deleteThread(profiled.thread.id).catch(() => undefined);
  });

  it("lists the locked App Server collaboration presets", async () => {
    const modes = await ownerClient.listCollaborationModes();

    expect(modes.some((mode) => mode.mode === "default")).toBe(true);
    expect(modes.some((mode) =>
      mode.mode === "plan" && mode.effort === "medium")).toBe(true);
  });

  it("persists Fast defaults for peer reads and subsequently started threads", async () => {
    const startedThreadIds: string[] = [];
    try {
      await ownerClient.writeDefaultFastMode(false);
      await expectConfiguredTier(peerClient, workdir, "default");
      const standardThread = await ownerClient.startThread(workdir);
      startedThreadIds.push(standardThread.thread.id);
      expect(standardThread.serviceTier).toBe("default");
      expect(standardThread.contextCompactionItemIds).toEqual([]);

      await ownerClient.writeDefaultFastMode(true);
      await expectConfiguredTier(peerClient, workdir, "fast");
      const fastThread = await ownerClient.startThread(workdir);
      startedThreadIds.push(fastThread.thread.id);
      expect(fastThread.serviceTier).toBe("priority");

      await ownerClient.writeDefaultFastMode(false);
      await expectConfiguredTier(peerClient, workdir, "default");
      const restoredThread = await ownerClient.startThread(workdir);
      startedThreadIds.push(restoredThread.thread.id);
      expect(restoredThread.serviceTier).toBe("default");
    } finally {
      for (const threadId of startedThreadIds) {
        await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
        await ownerClient.deleteThread(threadId);
      }
    }
  }, 15_000);

  it("maps Turn and Goal results through the stable Application contract", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const observedTurnIds: string[] = [];
    let observedPlanMode = false;
    let completedTurnDurationMs: number | undefined;
    const observedGoalEvents: string[] = [];
    const removeNotification = ownerClient.onNotification((notification) => {
      const event = toConversationInputEvent(notification);
      const threadState = toThreadStateEvent(notification);
      if (
        threadState?.type === "thread.settings.updated"
        && threadState.threadId === threadId
        && threadState.settings.collaborationMode === "plan"
      ) {
        observedPlanMode = true;
      }
      if (event?.type === "turn.started" && event.threadId === threadId) {
        observedTurnIds.push(event.turnId);
      }
      if (
        event?.type === "turn.completed"
        && event.threadId === threadId
        && event.turnId === turnId
      ) {
        completedTurnDurationMs = event.durationMs;
      }
      if (
        (event?.type === "thread.goal.updated" || event?.type === "thread.goal.cleared")
        && event.threadId === threadId
      ) {
        observedGoalEvents.push(event.type);
      }
    });
    let turnId: string | undefined;
    let peerSubscribed = false;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [{ type: "text", text: "contract-only" }],
        "codex_connect:contract",
        workdir,
        {
          collaborationMode: {
            mode: "plan",
            settings: {
              model: started.model,
              effort: "medium",
              developerInstructions: null,
            },
          },
        },
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
      await waitFor(() => observedTurnIds.includes(turn.turnId), 2_000);
      await waitFor(() => observedPlanMode, 2_000);

      const updated = await ownerClient.setGoal(threadId, "验证稳定 Goal 映射");
      const read = await peerClient.getGoal(threadId);
      expect(updated.objective).toBe("验证稳定 Goal 映射");
      expect(read).toEqual(updated);
      await waitFor(
        () => observedGoalEvents.includes("thread.goal.updated"),
        2_000,
      );

      await peerClient.close();
      peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
      peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
      await peerClient.connect();
      let resumedGoalObjective: string | undefined;
      const removePeerNotification = peerClient.onNotification((notification) => {
        const event = toConversationInputEvent(notification);
        if (event?.type === "thread.goal.updated" && event.threadId === threadId) {
          resumedGoalObjective = event.goal.objective;
        }
      });
      try {
        const resumed = await peerClient.resumeThread(threadId, workdir);
        peerSubscribed = true;
        expect(resumed.contextCompactionItemIds).toEqual([]);
        await waitFor(
          () => resumedGoalObjective === updated.objective,
          2_000,
        );
      } finally {
        removePeerNotification();
      }

      await ownerClient.clearGoal(threadId);
      await expect(peerClient.getGoal(threadId)).resolves.toBeNull();
      await waitFor(
        () => observedGoalEvents.includes("thread.goal.cleared"),
        2_000,
      );
      await ownerClient.interruptTurn(threadId, turnId);
      await waitFor(
        () => completedTurnDurationMs !== undefined,
        2_000,
      );
      expect(completedTurnDurationMs).toBeGreaterThanOrEqual(0);
      turnId = undefined;
    } finally {
      removeNotification();
      if (turnId) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      if (peerSubscribed) {
        await peerClient.unsubscribeThread(threadId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId).catch(() => undefined);
    }
  }, 15_000);

  it("accepts stable localAudio input through the real App Server", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const audioPath = join(testRuntime, "contract-silence.wav");
    writeFileSync(audioPath, wavSilence());
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [{ type: "localAudio", path: audioPath }],
        "codex_connect:contract",
        workdir,
      );
      turnId = turn.turnId;
      expect(turnId).not.toBe("");
    } finally {
      if (turnId !== undefined) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("accepts inline image Data URLs without local image paths", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let observedItem: Record<string, unknown> | undefined;
    const removeNotification = ownerClient.onNotification((notification) => {
      if (notification.method !== "item/completed" && notification.method !== "item/started") {
        return;
      }
      const params = typeof notification.params === "object" && notification.params !== null
        ? notification.params as Record<string, unknown>
        : {};
      if (params.threadId !== threadId) return;
      const item = typeof params.item === "object" && params.item !== null
        ? params.item as Record<string, unknown>
        : undefined;
      if (item?.type === "userMessage") {
        observedItem = item;
      }
    });
    let turnId: string | undefined;
    try {
      const turn = await ownerClient.startTurn(
        threadId,
        [{ type: "image", url: imageUrl }],
        "codex_connect:inline-image-contract",
        workdir,
      );
      turnId = turn.turnId;
      await waitFor(() => observedItem !== undefined, 2_000);
      expect(observedItem?.content).toEqual([{
        type: "image",
        url: imageUrl,
        detail: null,
      }]);
      expect(JSON.stringify(observedItem)).not.toContain("localImage");
      expect(JSON.stringify(observedItem)).not.toContain("path");
    } finally {
      removeNotification();
      if (turnId !== undefined) {
        await ownerClient.interruptTurn(threadId, turnId).catch(() => undefined);
      }
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("broadcasts peer model, effort and Fast changes across a peer reconnect", async () => {
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    const observedSettings: Array<{
      model: string;
      effort: string | null;
      serviceTier: string | null;
      collaborationMode: "default" | "plan";
    }> = [];
    const removeNotification = ownerClient.onNotification((notification) => {
      const event = toThreadStateEvent(notification);
      if (event?.type !== "thread.settings.updated" || event.threadId !== threadId) {
        return;
      }
      observedSettings.push(event.settings);
    });
    try {
      await peerRpc.request({
        method: "thread/settings/update",
        params: {
          threadId,
          model: "gpt-5.6-sol",
          effort: "high",
          serviceTier: "priority",
        },
        // 仅用于固定版本真实合同，不进入业务公开接口。
      } as never);
      await waitFor(
        () => observedSettings.some((settings) =>
          settings.model === "gpt-5.6-sol"
          && settings.effort === "high"
          && settings.serviceTier === "priority"),
        2_000,
      );

      await peerClient.close();
      peerRpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
      peerClient = new CodexAppServerClient(peerRpc, { sandbox: "read-only" });
      await peerClient.connect();

      await peerRpc.request({
        method: "thread/settings/update",
        params: {
          threadId,
          model: "gpt-5.6-sol",
          effort: "low",
          serviceTier: "default",
        },
        // 仅用于固定版本真实合同，不进入业务公开接口。
      } as never);
      await waitFor(
        () => observedSettings.some((settings) =>
          settings.model === "gpt-5.6-sol"
          && settings.effort === "low"
          && settings.serviceTier === "default"),
        2_000,
      );
    } finally {
      removeNotification();
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);

  it("persists model defaults through the official user config transaction", async () => {
    const configPath = join(codexHome, "config.toml");
    const before = parse(readFileSync(configPath, "utf8"));
    const models = await ownerClient.listModels();
    const model = models.find((candidate) =>
      candidate.available !== false
      && candidate.supportedReasoningEfforts.length > 0);
    if (!model) {
      throw new Error("隔离 Codex App Server 没有返回可写入的官方模型默认值");
    }
    const effort = model.defaultReasoningEffort;

    await ownerClient.writeDefaultModelSettings(model.model, effort);

    await expect(peerClient.readDefaultModelSettings()).resolves.toEqual({
      model: model.model,
      effort,
    });
    const after = parse(readFileSync(configPath, "utf8"));
    expect(after.model).toBe(model.model);
    expect(after.model_reasoning_effort).toBe(effort);
    expect(after.mcp_servers).toEqual(before.mcp_servers);
    expect(after.marketplaces).toEqual(before.marketplaces);
    expect(after.plugins).toEqual(before.plugins);
    expect(after.model_providers).toEqual(before.model_providers);
  }, 15_000);

  it("persists every unified user default through one official config transaction", async () => {
    const configPath = join(codexHome, "config.toml");
    const before = parse(readFileSync(configPath, "utf8"));
    const beforeWorkspace = before.sandbox_workspace_write as
      | Record<string, unknown>
      | undefined;
    const createClient = async () => ({
      connect: async () => undefined,
      close: async () => undefined,
      readUserConfigSnapshot: () => ownerClient.readUserConfigSnapshot(),
      writeUserConfigEdits: (
        edits: Parameters<typeof ownerClient.writeUserConfigEdits>[0],
        options?: Parameters<typeof ownerClient.writeUserConfigEdits>[1],
      ) => ownerClient.writeUserConfigEdits(edits, options),
      listModels: () => ownerClient.listModels(),
      readDefaultModelSettings: () => ownerClient.readDefaultModelSettings(),
      writeDefaultModelSettings: (model: string, effort: string) =>
        ownerClient.writeDefaultModelSettings(model, effort),
    });

    try {
      const settings = await loadCodexUserSettings({
        createClient,
        primaryProvider: () => "openai",
      });
      const model = settings.models.find((candidate) => candidate.isDefault)
        ?? settings.models[0];
      if (!model) throw new Error("真实 App Server 没有返回可用模型");
      await updateCodexUserSetting({
        kind: "all",
        model: model.model,
        reasoningEffort: model.defaultReasoningEffort,
        fastEnabled: true,
        sandboxMode: "workspace-write",
        approvalPolicy: "on-request",
        networkAccess: true,
      }, {
        expectedVersion: settings.version,
        createClient,
        primaryProvider: () => "openai",
      });

      const after = parse(readFileSync(configPath, "utf8"));
      expect(after.model).toBe(model.model);
      expect(after.model_reasoning_effort).toBe(model.defaultReasoningEffort);
      expect(after.service_tier).toBe("fast");
      expect(after.sandbox_mode).toBe("workspace-write");
      expect(after.approval_policy).toBe("on-request");
      expect(after.sandbox_workspace_write).toMatchObject({ network_access: true });
    } finally {
      await ownerClient.writeUserConfigEdits([
        { keyPath: "model", value: before.model ?? null },
        { keyPath: "model_reasoning_effort", value: before.model_reasoning_effort ?? null },
        { keyPath: "service_tier", value: before.service_tier ?? null },
        { keyPath: "sandbox_mode", value: before.sandbox_mode ?? null },
        { keyPath: "approval_policy", value: before.approval_policy ?? null },
        {
          keyPath: "sandbox_workspace_write.network_access",
          value: beforeWorkspace?.network_access ?? null,
        },
      ]);
    }
  }, 15_000);

  it("persists and removes an agent role through the official user config transaction", async () => {
    const configPath = join(codexHome, "config.toml");
    const roleConfigPath = join(codexHome, "contract-agent.config.toml");
    writeFileSync(roleConfigPath, 'developer_instructions = "Contract role"\n', {
      mode: 0o600,
    });

    try {
      await updateCodexUserConfig({
        ...process.env,
        CODEX_HOME: codexHome,
        CODEX_BINARY: process.env.CODEX_BINARY ?? "codex",
      }, () => [{
        keyPath: "features.multi_agent_v2",
        value: true,
      }, {
        keyPath: "agents.contract",
        value: {
          description: "Contract role",
          config_file: roleConfigPath,
          nickname_candidates: ["Contract"],
        },
      }]);

      const enabled = parse(readFileSync(configPath, "utf8"));
      expect(enabled.features).toMatchObject({ multi_agent_v2: true });
      expect(enabled.agents).toMatchObject({
        contract: {
          description: "Contract role",
          config_file: roleConfigPath,
          nickname_candidates: ["Contract"],
        },
      });

      await ownerClient.writeUserConfigEdits([{
        keyPath: "agents.contract",
        value: null,
      }]);

      const removed = parse(readFileSync(configPath, "utf8"));
      const removedAgents = removed.agents as Record<string, unknown> | undefined;
      expect(removedAgents?.contract).toBeUndefined();
    } finally {
      await ownerClient.writeUserConfigEdits([{
        keyPath: "agents.contract",
        value: null,
      }]).catch(() => undefined);
    }
  }, 15_000);
});

deepseekCatalogContractTest(
  "cold-resumes a third-party thread with its provider model catalog",
  async () => {
    const workdir = process.cwd();
    const runtimeRoot = resolve(".runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const testRuntime = mkdtempSync(join(runtimeRoot, "deepseek-resume-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const providerDirectory = join(testRuntime, "providers", "deepseek");
    const resolvedCatalogPath = deepseekCatalogPath
      ?? join(providerDirectory, "models.json");
    const socketPath = join(testRuntime, "app-server.sock");
    const apiServer = createServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: { type: "invalid_request_error", message: "contract failure" },
      }));
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      apiServer.once("error", rejectListen);
      apiServer.listen(0, "127.0.0.1", () => resolveListen());
    });
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("DeepSeek 冷恢复合同无法创建本机 API 夹具");
    }
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
    if (!deepseekCatalogPath) {
      writeFileSync(
        resolvedCatalogPath,
        `${JSON.stringify({
          models: [{
            slug: "deepseek-v4-flash",
            display_name: "DeepSeek-V4-Flash",
            description: "DeepSeek contract fixture",
            default_reasoning_level: "high",
            supported_reasoning_levels: [{
              effort: "high",
              description: "DeepSeek contract fixture",
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
        })}\n`,
        { mode: 0o600 },
      );
    }
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model = "deepseek-v4-flash"',
        'model_provider = "deepseek"',
        `model_catalog_json = ${JSON.stringify(resolvedCatalogPath)}`,
        "",
        "[model_providers.deepseek]",
        'name = "deepseek"',
        `base_url = "http://127.0.0.1:${apiAddress.port}/"`,
        'wire_api = "responses"',
        'experimental_bearer_token = "sk-contract-placeholder"',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    let processHandle: ChildProcess | undefined;
    let appServerStderr = "";
    let client: CodexAppServerClient | undefined;
    const startServer = async (): Promise<void> => {
      appServerStderr = "";
      processHandle = spawn(
        process.env.CODEX_BINARY ?? "codex",
        ["app-server", "--listen", `unix://${socketPath}`],
        {
          cwd: workdir,
          env: { ...process.env, CODEX_HOME: codexHome },
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      processHandle.stderr?.setEncoding("utf8");
      processHandle.stderr?.on("data", (chunk: string) => {
        appServerStderr = appendDiagnostic(appServerStderr, chunk);
      });
      await waitFor(
        () => existsSync(socketPath),
        10_000,
        () => processHandle?.exitCode === null
          ? undefined
          : new Error(appServerFailure(
            "DeepSeek 冷恢复合同 App Server 启动失败",
            appServerStderr,
          )),
      );
    };
    const stopServer = async (): Promise<void> => {
      if (processHandle?.exitCode === null) {
        processHandle.kill("SIGTERM");
        await new Promise((resolveExit) => processHandle?.once("exit", resolveExit));
      }
      rmSync(socketPath, { force: true });
    };
    try {
      await startServer();
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();
      const started = await client.startThread(workdir, {
        model: "deepseek-v4-flash",
        modelProvider: "deepseek",
      });
      const threadId = started.thread.id;
      let turnCompleted = false;
      const removeNotification = client.onNotification((notification) => {
        if (notification.method !== "turn/completed") return;
        const params = notification.params as { threadId?: unknown } | undefined;
        if (params?.threadId === threadId) turnCompleted = true;
      });
      await client.startTurn(
        threadId,
        [{ type: "text", text: "Persist the contract fixture." }],
        "codex_connect:deepseek-resume-contract",
        workdir,
      );
      await waitFor(() => turnCompleted, 10_000);
      removeNotification();
      await client.close();
      client = undefined;
      await stopServer();

      await startServer();
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();

      const resumed = await client.resumeThread(threadId, workdir);

      expect(resumed.model).toBe("deepseek-v4-flash");
      expect(resumed.modelProvider).toBe("deepseek");
      await client.unsubscribeThread(threadId).catch(() => undefined);
      await client.deleteThread(threadId);
    } finally {
      await client?.close().catch(() => undefined);
      await stopServer();
      await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
      rmSync(testRuntime, { recursive: true, force: true });
    }
  },
  30_000,
);

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

async function expectConfiguredTier(
  client: CodexAppServerClient,
  cwd: string,
  expected: string,
): Promise<void> {
  await expect(client.readDefaultServiceTier(cwd)).resolves.toBe(expected);
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

async function waitForMcpRuntimeStatus(
  client: CodexAppServerClient,
  threadId: string,
  serverName: string,
  expectedStatus: McpRuntimeStatus,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= 10_000) {
    const server = (await client.listMcpServerDetails(threadId))
      .find((entry) => entry.name === serverName);
    if (server?.runtimeStatus === expectedStatus) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(
    `等待 MCP Server ${serverName} 进入 ${expectedStatus} 状态超时`,
  );
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

function wavSilence(): Buffer {
  const sampleRate = 16_000;
  const sampleCount = 1_600;
  const dataBytes = sampleCount * 2;
  const result = Buffer.alloc(44 + dataBytes);
  result.write("RIFF", 0);
  result.writeUInt32LE(36 + dataBytes, 4);
  result.write("WAVE", 8);
  result.write("fmt ", 12);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRate, 24);
  result.writeUInt32LE(sampleRate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(dataBytes, 40);
  return result;
}

function appServerFailure(message: string, stderr: string): string {
  const sanitized = stderr
    .replace(/(authorization|token|password|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .trim();
  return sanitized ? `${message}\nApp Server stderr:\n${sanitized}` : message;
}
