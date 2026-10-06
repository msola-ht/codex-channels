import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
// @ts-expect-error JavaScript reader intentionally has no declaration file.
import { describeDumpExchange, listDumpFiles, summarizeDumpFiles } from "../scripts/traffic-dump-reader.mjs";

import {
  acquireAppServerProviderLease,
  applyAppServerProviderSettings,
  appServerSupervisorSocketPath,
  ensureAppServerProvider,
  inspectAppServerSupervisor,
  releaseAppServerProvider,
  readAppServerProviderSettingsFingerprint,
  sameAppServerTopology,
} from "../runtime/app-server-supervisor.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { waitForManagedServiceReadiness } from "../scripts/service-command.mjs";
import { resolveAppServerRuntime } from "../runtime/app-server-runtime.mjs";
import { cli, execFileAsync } from "./codexc-cli-test-fixture.js";
import { stopManagedAccountForRemoval } from "../scripts/managed-provider-account-runtime.mjs";
import { providerAppServerSocketPath, writeCustomPrimaryProviderSwitchingProfile } from "../runtime/model-provider-runtime.mjs";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { toConversationInputEvent } from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { appendDiagnostic, appServerFailure, stopDetachedTestProcess, waitFor } from "./support/real-app-server-helpers.js";
import { configuredHome, providerCatalogPath, testEnvironment } from "./model-provider-runtime-test-fixture.js";
import { createResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import type { ConfigReadResponse, ModelListResponse, ThreadStartResponse, ThreadReadResponse, TurnStartResponse } from "../src/codex-protocol/index.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;

contractSuite("real supervised App Server provider", () => {
    it.skipIf(process.platform !== "linux")("restarts a real isolated App Server through the unified CLI and reconnects", async () => {
      const root = mkdtempSync(join(tmpdir(), "restart-real-"));
      const managerPath = join(root, "systemctl.mjs");
      const environment = { ...process.env, HOME: root, CODEX_HOME: join(root, "codex"),
        CODEX_CONNECT_HOME: root, CODEX_CONNECT_CONFIG_FILE: join(root, "config.toml"),
        CODEX_CONNECT_SERVICE_ROLE: "", XDG_CONFIG_HOME: join(root, "config"), SYSTEMCTL_BINARY: managerPath };
      mkdirSync(environment.CODEX_HOME, { mode: 0o700 });
      initializeUserData({ environment, cwd: root });
      const document = readGatewayConfig(environment.CODEX_CONNECT_CONFIG_FILE);
      document.telegram = { bot_token: "fixture", allowed_user_ids: [1] };
      writeGatewayConfig(environment.CODEX_CONNECT_CONFIG_FILE, document);
      const definitionDirectory = join(environment.XDG_CONFIG_HOME, "systemd", "user");
      mkdirSync(definitionDirectory, { recursive: true });
      writeFileSync(join(definitionDirectory, "codex-connect-app-server.service"), "fixture");
      const children: ReturnType<typeof spawn>[] = [];
      let diagnostics = "";
      const start = () => {
        const child = spawn(process.execPath, [cli, "service-app-server"], {
          env: environment, cwd: root, detached: true, stdio: ["ignore", "ignore", "pipe"],
        });
        child.stderr?.on("data", chunk => { diagnostics = appendDiagnostic(diagnostics, String(chunk)); });
        children.push(child);
      };
      const operations: string[] = [];
      const manager = createServer(async (request, response) => {
        try {
          if (request.url === "/stop") {
            operations.push("stop");
            await stopDetachedTestProcess(children.at(-1)!, 10_000);
          } else if (request.url === "/start") {
            operations.push("start");
            start();
          } else { response.writeHead(400); response.end(); return; }
          response.end("ok");
        } catch { response.writeHead(500); response.end("fixture control failure"); }
      });
      let client: CodexAppServerClient | undefined;
      try {
        await new Promise<void>(resolveListen => manager.listen(0, "127.0.0.1", resolveListen));
        const address = manager.address();
        if (!address || typeof address === "string") throw new Error("Expected HTTP manager address");
        writeFileSync(managerPath, [
          `#!${process.execPath}`,
          'const action = process.argv[3];',
          'if (action === "show") console.log("LoadState=loaded\\nActiveState=active\\nSubState=running");',
          'else if (action === "stop" || action === "start") {',
          `  const response = await fetch("http://127.0.0.1:${address.port}/" + action, {method:"POST"});`,
          '  if (!response.ok) process.exitCode = 1;',
          '}',
        ].join("\n"));
        chmodSync(managerPath, 0o700);
        start();
        await waitForManagedServiceReadiness("app-server", environment, { timeoutMs: 10_000 });
        const { stdout } = await execFileAsync(process.execPath, [cli, "restart", "appserver"], { env: environment, cwd: root, timeout: 30_000 });
        expect(stdout).toContain("Codex App Server重启完成");
        expect(operations).toEqual(["stop", "start"]);
        expect(children).toHaveLength(2);
        expect(children[0]!.exitCode !== null || children[0]!.signalCode !== null).toBe(true);
        expect(children[1]!.pid).not.toBe(children[0]!.pid);
        const descriptor = resolveAppServerRuntime(document, root, environment);
        client = new CodexAppServerClient(new JsonRpcClient(new UnixWebSocketTransport(descriptor.primarySocketPath)), { sandbox: "read-only" });
        await expect(client.connect()).resolves.toHaveProperty("userAgent");
      } catch (error) {
        throw new Error(appServerFailure(error instanceof Error ? error.message : "restart failed", diagnostics), { cause: error });
      } finally {
        await client?.close();
        for (const child of children) await stopDetachedTestProcess(child, 10_000);
        if (manager.listening) await new Promise<void>((resolveClose, reject) => manager.close(error => error ? reject(error) : resolveClose()));
        rmSync(root, { recursive: true, force: true });
      }
    }, 45_000);

    it.each(["switching", "exclusive"] as const)("applies DS settings only to an idle unleased instance in %s mode", async (mode) => {
      const home = await configuredHome(mode);
      const environment = { ...process.env, ...testEnvironment(home) };
      const configPath = join(environment.CODEX_CONNECT_HOME!, "config.toml");
      const socketPath = join(home, "server.sock");
      const basePath = join(home, "config.toml");
      let upstreamRequests = 0;
      const apiServer = createServer((request, response) => {
        request.resume();
        if (request.method === "POST" && request.url === "/v1/responses") {
          upstreamRequests += 1;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.flushHeaders();
          return;
        }
        response.writeHead(404); response.end();
      });
      await new Promise<void>(resolveListen => apiServer.listen(0, "127.0.0.1", resolveListen));
      const address = apiServer.address();
      if (!address || typeof address === "string") throw new Error("fixture requires TCP address");
      const baseConfig = 'web_search = "live"\n' + (mode === "exclusive" ? readFileSync(basePath, "utf8") : 'model_provider = "openai"\n')
        + `\n[model_providers.settings_fixture]\nname="settings fixture"\nbase_url="http://127.0.0.1:${address.port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nsupports_websockets=false\n`;
      writeFileSync(basePath, baseConfig, { mode: 0o600 });
      writeFileSync(providerCatalogPath(home), JSON.stringify(createResponsesModelCatalog([
        {id:"deepseek-v4-flash",name:"DS fixture",contextWindow:64000,reasoningEfforts:["low", "high"],defaultReasoningEffort:"high",supportsImages:false},
      ], "deepseek-v4-flash")), { mode: 0o600 });
      writeGatewayConfig(configPath, {
        version: 1, default_workspace: "integration",
        telegram: { bot_token: "integration-token", allowed_user_ids: [123], message_format: "html" },
        codex: { binary: process.env.CODEX_BINARY ?? "codex", socket_path: socketPath, sandbox: "read-only" },
        approval: { timeout_seconds: 300 }, storage: { database_path: join(home, "gateway.sqlite3") },
        logging: { level: "info" }, workspaces: [{ id: "integration", name: "Integration", cwd: home }],
      });
      const service = spawn(process.execPath, [resolve("bin/codexc.mjs"), "service-app-server"], {
        cwd: process.cwd(), env: { ...environment, CODEX_CONNECT_CONFIG_FILE: configPath },
        stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      let diagnostic = "";
      for (const stream of [service.stdout, service.stderr]) {
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => { diagnostic = appendDiagnostic(diagnostic, chunk); });
      }
      let rpc: JsonRpcClient | undefined;
      let primaryRpc: JsonRpcClient | undefined;
      let primaryTurn: { threadId: string; turnId: string } | undefined;
      let lease: Awaited<ReturnType<typeof acquireAppServerProviderLease>> | undefined;
      try {
        await waitFor(() => existsSync(socketPath) && existsSync(appServerSupervisorSocketPath(socketPath)), 15000,
          () => service.exitCode === null && service.signalCode === null ? undefined : new Error(appServerFailure("DS fixture startup failed", diagnostic)));
        rpc = new JsonRpcClient(new UnixWebSocketTransport(socketPath));
        await rpc.connect();
        const primary = await rpc.request<ConfigReadResponse>({ method: "config/read", params: { includeLayers: false } });
        expect(primary.config.web_search).toBe(mode === "exclusive" ? "disabled" : "live");
        const initialSnapshot = { fingerprint: readAppServerProviderSettingsFingerprint("ds-test", environment), defaultModel: "deepseek-v4-flash" };
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: true, changed: false, snapshot: initialSnapshot });
        await rpc.request({ method: "config/read", params: { includeLayers: false } });
        if (mode === "switching") {
          primaryRpc = rpc;
          const { thread } = await primaryRpc.request<ThreadStartResponse>({ method: "thread/start", params: {
            cwd: home, modelProvider: "settings_fixture", model: "gpt-5.4", approvalPolicy: "never", sandbox: "read-only",
          } });
          const { turn } = await primaryRpc.request<TurnStartResponse>({ method: "turn/start", params: {
            threadId: thread.id, input: [{ type: "text", text: "keep the primary Provider active", text_elements: [] }],
          } });
          primaryTurn = { threadId: thread.id, turnId: turn.id };
          await vi.waitFor(() => expect(upstreamRequests).toBe(1));
          expect((await inspectAppServerSupervisor(socketPath))?.runningProviders).toEqual(["openai"]);
          await ensureAppServerProvider(socketPath, "ds-test");
          rpc = new JsonRpcClient(new UnixWebSocketTransport(providerAppServerSocketPath(socketPath, "ds-test")));
          await rpc.connect();
          const ds = await rpc.request<ConfigReadResponse>({ method: "config/read", params: { includeLayers: false } });
          expect(ds.config.web_search).toBe("disabled");
        }
        expect(readFileSync(basePath,"utf8")).toBe(baseConfig);
        const settingsPath = mode === "switching" ? join(home, "sf-ds-test.config.toml") : basePath;
        writeFileSync(settingsPath, readFileSync(settingsPath, "utf8") + '\n# settings pending\n', { mode: 0o600 });
        const { thread } = await rpc.request<ThreadStartResponse>({ method: "thread/start", params: {
          cwd: home, modelProvider: "settings_fixture", model: "deepseek-v4-flash", approvalPolicy: "never", sandbox: "read-only",
        } });
        const { turn } = await rpc.request<TurnStartResponse>({ method: "turn/start", params: {
          threadId: thread.id, input: [{ type: "text", text: "hold the fixture response", text_elements: [] }],
        } });
        await vi.waitFor(() => expect(upstreamRequests).toBe(mode === "switching" ? 2 : 1));
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: false, reason: "active", snapshot: initialSnapshot });
        const stillActive = await rpc.request<ThreadReadResponse>({ method: "thread/read", params: { threadId: thread.id, includeTurns: false } });
        expect(stillActive.thread.status.type).toBe("active");
        await rpc.request({ method: "turn/interrupt", params: { threadId: thread.id, turnId: turn.id } });
        await vi.waitFor(async () => {
          const result = await rpc!.request<ThreadReadResponse>({ method: "thread/read", params: { threadId: thread.id, includeTurns: false } });
          expect(result.thread.status.type).toBe("idle");
        });
        const settings = readFileSync(settingsPath, "utf8").replace('model = "deepseek-v4-flash"', 'model = "deepseek-v4-updated"');
        writeFileSync(settingsPath, mode === "switching"
          ? settings.replace('model_reasoning_effort = "high"', 'model_reasoning_effort = "low"')
          : settings, { mode: 0o600 });
        writeFileSync(providerCatalogPath(home), JSON.stringify(createResponsesModelCatalog([
          {id:"deepseek-v4-updated",name:"DS fixture updated",contextWindow:64000,reasoningEfforts:["low", "high"],defaultReasoningEffort:"low",supportsImages:false},
        ], "deepseek-v4-updated")), { mode: 0o600 });
        lease = await acquireAppServerProviderLease(socketPath, "ds-test");
        expect(readAppServerProviderSettingsFingerprint("ds-test", environment)).not.toBe(initialSnapshot.fingerprint);
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: false, reason: "leased", snapshot: initialSnapshot });
        await rpc.request({ method: "config/read", params: { includeLayers: false } });
        await lease.close();
        await vi.waitFor(async () => expect((await inspectAppServerSupervisor(socketPath))?.leasedProviders).toEqual([]));
        const validSettings = readFileSync(settingsPath, "utf8");
        writeFileSync(settingsPath, validSettings.replace('model = "deepseek-v4-updated"', 'model = "missing-model"'), { mode: 0o600 });
        await expect(applyAppServerProviderSettings(socketPath, "ds-test")).rejects.toThrow("应用失败");
        await rpc.request({ method: "config/read", params: { includeLayers: false } });
        writeFileSync(settingsPath, validSettings, { mode: 0o600 });
        if (mode === "exclusive") {
          const validBase = readFileSync(basePath, "utf8");
          writeFileSync(basePath, 'sandbox_mode = "invalid-fixture-mode"\n' + validBase, { mode: 0o600 });
          await expect(applyAppServerProviderSettings(socketPath, "ds-test")).rejects.toThrow("应用失败");
          expect((await inspectAppServerSupervisor(socketPath))?.releasedProviders).toContain("ds-test");
          expect((await inspectAppServerSupervisor(socketPath))?.runningProviders).not.toContain("ds-test");
          writeFileSync(basePath, validBase, { mode: 0o600 });
          // A subsequent native TUI startup can finish the failed settings recovery.
          lease = await acquireAppServerProviderLease(socketPath, "ds-test");
          await lease.close();
          await vi.waitFor(async () => expect((await inspectAppServerSupervisor(socketPath))?.leasedProviders).toEqual([]));
        }
        const updatedSnapshot = { fingerprint: readAppServerProviderSettingsFingerprint("ds-test", environment), defaultModel: "deepseek-v4-updated" };
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: true, changed: mode !== "exclusive", snapshot: updatedSnapshot });
        expect((await inspectAppServerSupervisor(socketPath))?.runningProviders).toContain("ds-test");
        await rpc.close();
        rpc = new JsonRpcClient(new UnixWebSocketTransport(mode === "exclusive"
          ? socketPath : providerAppServerSocketPath(socketPath, "ds-test")));
        await rpc.connect();
        const updated = await rpc.request<ConfigReadResponse>({ method: "config/read", params: { includeLayers: false } });
        expect(updated.config.model).toBe("deepseek-v4-updated");
        if (mode === "switching") expect(updated.config.model_reasoning_effort).toBe("low");
        const models = await rpc.request<ModelListResponse>({ method: "model/list", params: {} });
        expect(models.data.find(model => model.model === "deepseek-v4-updated")?.defaultReasoningEffort).toBe("low");
        expect(updated.config.web_search).toBe("disabled");
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: true, changed: false, snapshot: updatedSnapshot });
        await rpc.request({ method: "config/read", params: { includeLayers: false } });
        if (primaryRpc) {
          const unchanged = await primaryRpc.request<ConfigReadResponse>({ method: "config/read", params: { includeLayers: false } });
          expect(unchanged.config.web_search).toBe("live");
          const active = await primaryRpc.request<ThreadReadResponse>({ method: "thread/read", params: {
            threadId: primaryTurn!.threadId, includeTurns: false,
          } });
          expect(active.thread.status.type).toBe("active");
        }
        // Cancel exactly when the selected shared instance disconnects: the owner
        // must finish restoration even though the Gateway caller stopped waiting.
        writeFileSync(settingsPath, readFileSync(settingsPath, "utf8").replace('model = "deepseek-v4-updated"', 'model = "deepseek-v4-restored"'), { mode: 0o600 });
        writeFileSync(providerCatalogPath(home), JSON.stringify(createResponsesModelCatalog([
          {id:"deepseek-v4-restored",name:"DS restored fixture",contextWindow:64000,reasoningEfforts:["low", "high"],defaultReasoningEffort:"low",supportsImages:false},
        ], "deepseek-v4-restored")), { mode: 0o600 });
        const cancellation = new AbortController();
        const unsubscribe = rpc.onDisconnect(() => cancellation.abort(new Error("settings caller stopped")));
        try {
          await expect(applyAppServerProviderSettings(socketPath, "ds-test", cancellation.signal)).rejects.toThrow("settings caller stopped");
          expect(cancellation.signal.aborted).toBe(true);
        } finally { unsubscribe(); }
        await rpc.close();
        await vi.waitFor(async () => {
          const reconnected = new JsonRpcClient(new UnixWebSocketTransport(mode === "exclusive"
            ? socketPath : providerAppServerSocketPath(socketPath, "ds-test")));
          try {
            await reconnected.connect();
            const restored = await reconnected.request<ConfigReadResponse>({ method: "config/read", params: { includeLayers: false } });
            expect(restored.config.model).toBe("deepseek-v4-restored");
            rpc = reconnected;
          } catch (error) {
            await reconnected.close();
            throw error;
          }
        }, { timeout: 15000, interval: 50 });
        await vi.waitFor(async () => {
          expect((await inspectAppServerSupervisor(socketPath))?.runningProviders).toContain("ds-test");
        });
        lease = await acquireAppServerProviderLease(socketPath, "ds-test");
        const restoredSnapshot = { fingerprint: readAppServerProviderSettingsFingerprint("ds-test", environment), defaultModel: "deepseek-v4-restored" };
        // Cancellation suppresses the caller's confirmation, not the host's successfully applied baseline.
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: false, reason: "leased", snapshot: restoredSnapshot });
        await lease.close();
        await vi.waitFor(async () => expect((await inspectAppServerSupervisor(socketPath))?.leasedProviders).toEqual([]));
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({
          applied: true, changed: false, snapshot: restoredSnapshot,
        });
        // An idle release ends that process's baseline. A native lease must start
        // from the new material, including switching-mode CLI overrides.
        await rpc.close();
        expect(await releaseAppServerProvider(socketPath, "ds-test")).toEqual({ released: true, reason: "released" });
        writeFileSync(settingsPath, readFileSync(settingsPath, "utf8").replace('model = "deepseek-v4-restored"', 'model = "deepseek-v4-native"'), { mode: 0o600 });
        writeFileSync(providerCatalogPath(home), JSON.stringify(createResponsesModelCatalog([
          {id:"deepseek-v4-native",name:"DS native fixture",contextWindow:64000,reasoningEfforts:["low", "high"],defaultReasoningEffort:"low",supportsImages:false},
        ], "deepseek-v4-native")), { mode: 0o600 });
        lease = await acquireAppServerProviderLease(socketPath, "ds-test");
        rpc = new JsonRpcClient(new UnixWebSocketTransport(mode === "exclusive"
          ? socketPath : providerAppServerSocketPath(socketPath, "ds-test")));
        await rpc.connect();
        const native = await rpc.request<ConfigReadResponse>({ method: "config/read", params: { includeLayers: false } });
        expect(native.config.model).toBe("deepseek-v4-native");
        const nativeSnapshot = { fingerprint: readAppServerProviderSettingsFingerprint("ds-test", environment), defaultModel: "deepseek-v4-native" };
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: false, reason: "leased", snapshot: nativeSnapshot });
        await lease.close();
        await vi.waitFor(async () => expect((await inspectAppServerSupervisor(socketPath))?.leasedProviders).toEqual([]));
        expect(await applyAppServerProviderSettings(socketPath, "ds-test")).toEqual({ applied: true, changed: false, snapshot: nativeSnapshot });
        if (primaryRpc && primaryTurn) {
          const active = await primaryRpc.request<ThreadReadResponse>({ method: "thread/read", params: {
            threadId: primaryTurn.threadId, includeTurns: false,
          } });
          expect(active.thread.status.type).toBe("active");
          await primaryRpc.request({ method: "turn/interrupt", params: primaryTurn });
        }
      } finally {
        await lease?.close();
        await primaryRpc?.close();
        await rpc?.close();
        await stopDetachedTestProcess(service, 5000);
        apiServer.closeAllConnections();
        await new Promise<void>(resolveClose => apiServer.close(() => resolveClose()));
        rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }, 30000);

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
        'model_provider = "thirdparty"',
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
        debug: { model_traffic_dump: true },
        default_workspace: "integration",
        telegram: {
          bot_token: "integration-token",
          allowed_user_ids: [123],
          message_format: "html",
        },
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
          await vi.waitFor(async () => {
            const files = listDumpFiles(join(testRuntime, "traffic"));
            const summary = (await summarizeDumpFiles(files)).exchanges.find((entry: { turnId?: string }) => entry.turnId === turn.turnId);
            expect(summary).toBeDefined();
            const detail = await describeDumpExchange(files, summary.id);
            expect(detail.response.callTiming.totalMs).toBeGreaterThanOrEqual(0);
            expect(detail.response.firstTokenMs).toBeGreaterThanOrEqual(0);
            expect(detail.response.callTiming.totalMs).toBeGreaterThanOrEqual(detail.response.firstTokenMs);
          }, { timeout: 5000 });

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
      const openCodeSocketPath = providerAppServerSocketPath(socketPath, "ocg-main");
      const supervisorSocketPath = appServerSupervisorSocketPath(socketPath);
      const providerDirectory = join(testRuntime, "providers", "opencode-go");
      const accountDirectory = join(providerDirectory, "accounts", "main");
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      mkdirSync(accountDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(workspace, { recursive: true, mode: 0o700 });
      const roleConfigPath = join(codexHome, "sf-agent.config.toml");
      writeFileSync(
        roleConfigPath,
        [
          'model = "deepseek-v4-flash"',
          'model_reasoning_effort = "low"',
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
          }, { effort: "low", description: "Role selection" }],
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
          }, { effort: "low", description: "Role selection" }],
        }],
      })}\n`;
      writeFileSync(
        catalogPath,
        invalidForCodexCatalog,
        { mode: 0o600 },
      );
      writeFileSync(
        join(providerDirectory, "accounts.json"),
        '[{"id":"main","default":true,"email":"user@example.com"}]\n',
        { mode: 0o600 },
      );
      writeFileSync(
        join(accountDirectory, "managed.toml"),
        'version = 1\nprovider = "ocg-main"\nmode = "switching"\n',
        { mode: 0o600 },
      );
      writeFileSync(
        join(codexHome, "sf-ocg-main.config.toml"),
        [
          'model = "deepseek-v4-flash"',
          'model_provider = "ocg-main"',
          'model_reasoning_effort = "high"',
          `model_catalog_json = ${JSON.stringify(catalogPath)}`,
          "[model_providers.ocg-main]",
          'name = "ocg-main"',
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
          managedProviders: ["ocg-main"],
          socketPaths: [socketPath, openCodeSocketPath],
        })).toBe(true);

        client = new CodexAppServerClient(
          new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
          { sandbox: "read-only" },
        );
        const initialized = await client.connect();
        expect(initialized.userAgent).toContain("codex-tui/");

        await expect(ensureAppServerProvider(socketPath, "ocg-main"))
          .rejects.toThrow("模型 Provider App Server 启动失败：ocg-main（exit=1）");
        expect(service.exitCode).toBeNull();
        expect(await client.listModels()).not.toHaveLength(0);
        expect(await inspectAppServerSupervisor(socketPath)).toMatchObject({
          primaryProvider: "openai",
        });

        writeFileSync(catalogPath, validCatalog, { mode: 0o600 });
        await ensureAppServerProvider(socketPath, "ocg-main").catch((error) => {
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
        expect(openCodeInitialized.userAgent).toContain("codex-tui/");
        const providerLease = await acquireAppServerProviderLease(socketPath, "ocg-main");
        try {
          expect(await inspectAppServerSupervisor(socketPath)).toMatchObject({
            leasedProviders: ["ocg-main"],
          });
          await expect(stopManagedAccountForRemoval("ocg-main", { resolvePrimarySocket: () => socketPath }))
            .rejects.toMatchObject({ code: "account-runtime-in-use" });
        } finally {
          await providerLease.close();
        }
        const models = await openCodeClient.listModels();
        expect(models.some(({ model }) => model === "deepseek-v4-flash")).toBe(true);
        await openCodeClient.close();
        openCodeClient = undefined;
        await expect(stopManagedAccountForRemoval("ocg-main", { resolvePrimarySocket: () => socketPath }))
          .resolves.toBe("stopped");

        const primaryLease = await acquireAppServerProviderLease(socketPath, "openai");
        try {
          await expect(releaseAppServerProvider(socketPath, "openai"))
            .resolves.toEqual({ released: false, reason: "leased" });
        } finally {
          await primaryLease.close();
        }
        await client.close().catch(() => undefined);
        client = undefined;
        await expect(releaseAppServerProvider(socketPath, "openai"))
          .resolves.toEqual({ released: true, reason: "released" });
        expect(await inspectAppServerSupervisor(socketPath)).toMatchObject({
          releasedProviders: ["ocg-main", "openai"],
        });
        await expect(ensureAppServerProvider(socketPath, "openai")).resolves.toBeUndefined();
        client = new CodexAppServerClient(
          new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
          { sandbox: "read-only" },
        );
        await expect(client.connect()).resolves.toMatchObject({
          userAgent: expect.stringContaining("codex-tui/"),
        });
      } finally {
        try {
          await openCodeClient?.close().catch(() => undefined);
          await client?.close().catch(() => undefined);
          await stopDetachedTestProcess(service, 10_000);
          await waitFor(() => !existsSync(supervisorSocketPath), 2_000);
          expect(existsSync(roleConfigPath)).toBe(true);
          expect(readFileSync(roleConfigPath, "utf8")).not.toContain("api_key");
          expect(readFileSync(roleConfigPath, "utf8")).not.toContain("model_provider");
          expect(readFileSync(roleConfigPath, "utf8")).not.toContain("base_url");
          expect(readFileSync(roleConfigPath, "utf8")).toContain('model_reasoning_effort = "low"');
        } finally {
          rmSync(testRuntime, { recursive: true, force: true });
        }
      }
    }, 45_000);
  });
