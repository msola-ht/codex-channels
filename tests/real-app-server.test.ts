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
import { appendDiagnostic, appServerFailure, signalTestProcessTree, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const deepseekCatalogPath = process.env.CODEX_DEEPSEEK_MODEL_CATALOG;
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
      const userConfig = await client.readUserConfigSnapshot();
      await client.writeUserConfigEdits([{
        keyPath: "features.context_management.experimental_mode",
        value: true,
      }], { expectedVersion: userConfig.version });
      await expect(client.readUserConfigSnapshot()).resolves.toMatchObject({
        config: {
          features: {
            context_management: {
              experimental_mode: true,
            },
          },
        },
      });
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
