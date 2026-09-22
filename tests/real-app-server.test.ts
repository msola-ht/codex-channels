import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { ProviderProxy } from "../src/provider-proxy/index.js";
import { ModelSelectionService } from "../src/application/model-selection-service.js";
import { ConversationService } from "../src/application/conversation-service.js";
import type { ConversationCore } from "../src/conversation-core/index.js";
import { SessionRouter } from "../src/session-routing/index.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";
import { appendDiagnostic, appServerFailure, signalTestProcessTree, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const deepseekCatalogPath = process.env.CODEX_DEEPSEEK_MODEL_CATALOG;
const contractTest = runContract ? it : it.skip;
const deepseekCatalogContractTest = runContract ? it : it.skip;

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

  it.skipIf(process.platform === "win32")(
    "force stops a process that exceeds the graceful shutdown window",
    async () => {
      const runtimeRoot = resolve(".runtime");
      mkdirSync(runtimeRoot, { recursive: true });
      const testRuntime = mkdtempSync(join(runtimeRoot, "process-force-stop-"));
      const markerPath = join(testRuntime, "ready");
      const childSource = [
        'const { writeFileSync } = require("node:fs");',
        'process.on("SIGTERM", () => undefined);',
        'writeFileSync(process.argv[1], "ready");',
        "setInterval(() => undefined, 1_000);",
      ].join("\n");
      const child = spawn(process.execPath, ["-e", childSource, markerPath], {
        detached: true,
        stdio: "ignore",
      });

      try {
        await waitFor(() => existsSync(markerPath), 1_000);
        await stopDetachedTestProcess(child, 100);
        expect(child.signalCode).toBe("SIGKILL");
      } finally {
        signalTestProcessTree(child, "SIGKILL");
        rmSync(testRuntime, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  );
});

contractTest(
  "reads the no-login OpenAI account route without refreshing credentials",
  async () => {
    const runtimeRoot = resolve(".runtime");
    mkdirSync(runtimeRoot, { recursive: true });
    const testRuntime = mkdtempSync(join(runtimeRoot, "account-route-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const socketPath = join(testRuntime, "app-server.sock");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), "", { mode: 0o600 });
    let processHandle: ChildProcess | undefined;
    let appServerStderr = "";
    let client: CodexAppServerClient | undefined;
    try {
      const environment: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome };
      delete environment.OPENAI_API_KEY;
      processHandle = spawn(
        process.env.CODEX_BINARY ?? "codex",
        ["app-server", "--listen", `unix://${socketPath}`],
        {
          cwd: process.cwd(),
          env: environment,
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
            "账户线路合同 App Server 启动失败",
            appServerStderr,
          )),
      );
      client = new CodexAppServerClient(
        new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
        { sandbox: "read-only" },
      );
      await client.connect();

      await expect(client.openAiAccountRoute()).resolves.toBe("chatgpt");
    } finally {
      await client?.close().catch(() => undefined);
      if (processHandle?.exitCode === null) {
        processHandle.kill("SIGTERM");
        await new Promise((resolveExit) => processHandle?.once("exit", resolveExit));
      }
      rmSync(testRuntime, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  15_000,
);

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
    let upstreamRequests = 0;
    const apiServer = createServer((_request, response) => {
      upstreamRequests += 1;
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
    const proxy = new ProviderProxy("127.0.0.1:0", {
      upstreamHost: "127.0.0.1",
      resolveUpstream: async () => {
        await new Promise<void>((resolveRoute) => setImmediate(resolveRoute));
        return { host: "127.0.0.1", port: apiAddress.port, protocol: "http" };
      },
    });
    await proxy.start();
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
        `base_url = "http://${proxy.address()}/"`,
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
      expect(existsSync(join(codexHome, "auth.json"))).toBe(false);
      const router = new SessionRouter(client, new MemoryBindingStore(), new WorkspaceRegistry([
        { id: "contract", name: "Contract", cwd: workdir },
      ], "contract"));
      const selection = new ModelSelectionService(
        client,
        router,
        undefined,
        (await client.listModels()).map((model) => ({
          ...model, provider: "deepseek", isDefault: model.model === "deepseek-v4-flash",
        })),
        "openai", [], () => false,
      );
      const target = { surface: "telegram" as const, accountId: "contract", conversationId: "default" };
      const defaults = selection.threadStartOptions(target);
      expect(defaults).toEqual({ model: "deepseek-v4-flash", modelProvider: "deepseek" });
      const conversations = new ConversationService(client, router, {
        activeTurn: () => undefined, markTurnStarted: () => undefined,
      } as unknown as ConversationCore, selection, client);
      await expect(conversations.getGoal(target)).resolves.toBeNull();
      expect(router.modelSettings(target)).toMatchObject({ model: "deepseek-v4-flash", modelProvider: "deepseek" });
      const threadId = router.current(target)!.threadId;
      let turnCompleted = false;
      const removeNotification = client.onNotification((notification) => {
        if (notification.method !== "turn/completed") return;
        const params = notification.params as { threadId?: unknown } | undefined;
        if (params?.threadId === threadId) turnCompleted = true;
      });
      const submission = await conversations.submit(target, "Persist the contract fixture.");
      expect(submission.threadId).toBe(threadId);
      await waitFor(() => turnCompleted, 10_000);
      expect(upstreamRequests).toBeGreaterThan(0);
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
      await proxy.close();
      await new Promise<void>((resolveClose) => apiServer.close(() => resolveClose()));
      rmSync(testRuntime, { recursive: true, force: true });
    }
  },
  30_000,
);
