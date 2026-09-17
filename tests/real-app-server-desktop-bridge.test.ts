import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { UnixWebSocketTransport } from "../src/codex-client/index.js";
import {
  desktopAppBridgeTokenPath,
  proxyDesktopAppStdioToUnixSocket,
  startDesktopAppBridge,
} from "../runtime/desktop-app-bridge.mjs";
import { inspectAppServerSupervisor } from "../runtime/app-server-supervisor.mjs";
import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { readPrivateFileSync } from "../runtime/private-file.mjs";
import {
  appendDiagnostic,
  appServerFailure,
  stopDetachedTestProcess,
  waitFor,
} from "./support/real-app-server-helpers.js";

const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;
const contractTmpdir = process.platform === "darwin" ? "/tmp" : tmpdir();

contractSuite("real Codex Desktop App bridge", () => {
  it("shares one supervised OpenAI App Server and releases its client leases", async () => {
    const testRuntime = mkdtempSync(join(contractTmpdir, "codex-desktop-bridge-contract-"));
    const codexHome = join(testRuntime, "codex-home");
    const workspace = join(testRuntime, "workspace");
    const configPath = join(testRuntime, "config.toml");
    const socketPath = join(testRuntime, "app-server.sock");
    const bridgePort = await reservePort();
    const codexBinary = process.env.CODEX_BINARY ?? "codex";
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    writeFileSync(join(codexHome, "config.toml"), "model_provider = \"openai\"\n", {
      mode: 0o600,
    });
    writeGatewayConfig(configPath, {
      version: 1,
      default_workspace: "contract",
      telegram: {
        bot_token: "desktop-bridge-contract",
        allowed_user_ids: [123],
        message_format: "html",
      },
      codex: {
        binary: codexBinary,
        socket_path: socketPath,
        sandbox: "read-only",
        ...(process.platform === "darwin" || process.platform === "win32"
          ? { desktop_app: { enabled: true, port: bridgePort } }
          : {}),
      },
      approval: { timeout_seconds: 300 },
      storage: { database_path: join(testRuntime, "gateway.sqlite3") },
      logging: { level: "info" },
      workspaces: [{ id: "contract", name: "Contract", cwd: workspace }],
    });
    let stdout = "";
    let stderr = "";
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
          CODEX_BINARY: codexBinary,
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
    let first: RawBridgeClient | undefined;
    let second: RawBridgeClient | undefined;
    let bridge: Awaited<ReturnType<typeof startDesktopAppBridge>> | undefined;
    let threadId: string | undefined;
    try {
      const tokenPath = desktopAppBridgeTokenPath(testRuntime);
      await waitFor(
        () => existsSync(socketPath) && (
          process.platform !== "win32"
          || (
            existsSync(tokenPath)
            && stdout.includes("Codex Desktop App 桥已启动")
          )
        ),
        15_000,
        () => service.exitCode === null && service.signalCode === null
          ? undefined
          : new Error(appServerFailure(
              "Desktop 桥合同 App Server 服务在就绪前退出",
              `${stdout}\n${stderr}`,
            )),
      );
      if (process.platform !== "darwin" && process.platform !== "win32") {
        expect(existsSync(tokenPath)).toBe(false);
        bridge = await startDesktopAppBridge({
          port: bridgePort,
          socketPath,
          primaryProvider: "openai",
          codexBinary,
          dataDir: testRuntime,
          createTransport: () => new UnixWebSocketTransport(socketPath),
        });
      }
      if (process.platform !== "win32") {
        const input = new PassThrough();
        const output = new PassThrough();
        const responses = createInterface({ input: output, crlfDelay: Infinity });
        const initialized = new Promise<Record<string, unknown>>((resolvePromise) => {
          responses.once("line", (line) => {
            resolvePromise(JSON.parse(line) as Record<string, unknown>);
          });
        });
        const proxy = proxyDesktopAppStdioToUnixSocket({ socketPath, input, output });
        input.write(`${JSON.stringify({
          method: "initialize",
          id: 1,
          params: {
            clientInfo: {
              name: "codex_connect_desktop_stdio_contract",
              title: "Codex Desktop Stdio Contract",
              version: "0.154.0",
            },
            capabilities: {
              experimentalApi: false,
              requestAttestation: false,
              optOutNotificationMethods: null,
              extensions: null,
            },
          },
        })}\n`);
        await expect(initialized).resolves.toMatchObject({ id: 1, result: {} });
        input.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        input.end();
        await proxy;
        responses.close();
      }
      if (process.platform === "darwin") return;
      const bridgeToken = readPrivateFileSync(tokenPath, 128);
      const endpoint = `ws://127.0.0.1:${bridgePort}/codex-app-server?token=${bridgeToken}`;
      first = new RawBridgeClient(endpoint, "codex_connect_bridge_contract_first");
      second = new RawBridgeClient(endpoint, "codex_connect_bridge_contract_second");
      await first.connect();
      await second.connect();
      await expect(inspectAppServerSupervisor(socketPath)).resolves.toMatchObject({
        primaryProvider: "openai",
        leasedProviders: ["openai"],
      });

      const started = await first.request("thread/start", {
        cwd: workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
      });
      threadId = started.thread?.id;
      expect(threadId).toEqual(expect.any(String));
      const read = await second.request("thread/read", {
        threadId,
        includeTurns: false,
      });
      expect(read.thread?.id).toBe(threadId);
      expect(read.thread?.cwd).toBe(workspace);

      await first.request("thread/unsubscribe", { threadId }).catch(() => undefined);
      await second.request("thread/unsubscribe", { threadId }).catch(() => undefined);
      threadId = undefined;
      await first.close();
      first = undefined;
      await second.close();
      second = undefined;
      await waitForSupervisorLeases(socketPath, 5_000);
    } finally {
      if (threadId) {
        await first?.request("thread/unsubscribe", { threadId }).catch(() => undefined);
        await second?.request("thread/unsubscribe", { threadId }).catch(() => undefined);
      }
      await first?.close().catch(() => undefined);
      await second?.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      if (service.exitCode === null && service.signalCode === null) {
        await stopDetachedTestProcess(service, 10_000);
      }
      rmSync(testRuntime, { recursive: true, force: true });
    }
  }, 30_000);
});

class RawBridgeClient {
  private socket: WebSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve(value: RpcResult): void; reject(error: Error): void }
  >();

  constructor(
    private readonly endpoint: string,
    private readonly clientName: string,
  ) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(this.endpoint, { perMessageDeflate: false });
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString("utf8")) as {
        id?: number;
        result?: RpcResult;
        error?: { message?: string };
      };
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "App Server 请求失败"));
      } else {
        pending.resolve(message.result ?? {});
      }
    });
    socket.once("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Desktop 桥合同连接已关闭"));
      }
      this.pending.clear();
    });
    await new Promise<void>((resolvePromise, rejectPromise) => {
      socket.once("open", () => resolvePromise());
      socket.once("error", rejectPromise);
    });
    await this.request("initialize", {
      clientInfo: {
        name: this.clientName,
        title: "Codex Desktop Bridge Contract",
        version: "0.154.0",
      },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: null,
        extensions: null,
      },
    });
    await this.notify("initialized", {});
  }

  request(method: string, params: unknown): Promise<RpcResult> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Desktop 桥合同连接未打开"));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
      socket.send(JSON.stringify({ method, id, params }), (error) => {
        if (!error) return;
        this.pending.delete(id);
        rejectPromise(error);
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Desktop 桥合同连接未打开"));
    }
    return new Promise((resolvePromise, rejectPromise) => {
      socket.send(JSON.stringify({ method, params }), (error) =>
        error ? rejectPromise(error) : resolvePromise());
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolvePromise) => {
      socket.once("close", () => resolvePromise());
      socket.close();
    });
  }
}

interface RpcResult {
  thread?: {
    id?: string;
    cwd?: string;
  };
  [key: string]: unknown;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得 Desktop 桥合同端口");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
  return address.port;
}

async function waitForSupervisorLeases(socketPath: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    const topology = await inspectAppServerSupervisor(socketPath);
    if (topology?.leasedProviders.length === 0) return;
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("等待 Desktop 桥主 Provider 租约释放超时");
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}
