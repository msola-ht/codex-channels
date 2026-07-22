import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CodexAppServerClient } from "../src/codex-client/client.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { StdioTransport } from "../src/codex-client/stdio-transport.js";

const run = process.env.RUN_CODEX_INTEGRATION === "1";
const suite = run ? describe : describe.skip;

suite("real Codex App Server over Unix WebSocket", () => {
  const workdir = process.cwd();
  const runtimeRoot = resolve(".runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const testRuntime = mkdtempSync(join(runtimeRoot, "integration-"));
  const socketPath = join(testRuntime, "app-server.sock");
  let processHandle: ChildProcess;
  let client: CodexAppServerClient;

  beforeAll(async () => {
    processHandle = spawn("codex", ["app-server", "--listen", `unix://${socketPath}`], {
      cwd: workdir,
      stdio: ["ignore", "ignore", "pipe"],
    });
    await waitFor(() => existsSync(socketPath), 10_000);
    const transport = new UnixWebSocketTransport(socketPath);
    client = new CodexAppServerClient(new JsonRpcClient(transport), {
      cwd: workdir,
      sandbox: "read-only",
    });
    await client.connect();
  }, 15_000);

  afterAll(async () => {
    await client?.close();
    if (processHandle?.exitCode === null) {
      processHandle.kill("SIGTERM");
      await new Promise((resolveExit) => processHandle.once("exit", resolveExit));
    }
    rmSync(testRuntime, { recursive: true, force: true });
  });

  it("lists native threads without starting a turn", async () => {
    const threads = await client.listThreads();
    expect(Array.isArray(threads)).toBe(true);
    pino({ enabled: false }).info({ count: threads.length });
  });

  it("reads account rate-limit snapshots without starting a turn", async () => {
    const result = await client.accountRateLimits();

    expect(result.rateLimits).toBeDefined();
    expect(result.rateLimits.primary === null || typeof result.rateLimits.primary.usedPercent === "number").toBe(true);
  });
});

suite("real Codex App Server over stdio", () => {
  let client: CodexAppServerClient;

  afterAll(async () => {
    await client?.close();
  });

  it("uses the same client contract to initialize and list threads", async () => {
    const workdir = process.cwd();
    client = new CodexAppServerClient(
      new JsonRpcClient(new StdioTransport({ codexBinary: "codex", cwd: workdir })),
      { cwd: workdir, sandbox: "read-only" },
    );

    const initialized = await client.connect();
    const threads = await client.listThreads();

    expect(initialized.platformOs).toBe("macos");
    expect(Array.isArray(threads)).toBe(true);
  }, 15_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("等待 Codex App Server Unix Socket 超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
