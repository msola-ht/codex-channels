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
const archiveFixtureThreadId = process.env.CODEX_ARCHIVE_FIXTURE_THREAD_ID;
const archiveTest = run && archiveFixtureThreadId ? it : it.skip;

suite("real Codex App Server over Unix WebSocket", () => {
  const workdir = process.cwd();
  const runtimeRoot = resolve(".runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const testRuntime = mkdtempSync(join(runtimeRoot, "integration-"));
  const socketPath = join(testRuntime, "app-server.sock");
  let processHandle: ChildProcess;
  let client: CodexAppServerClient;
  let upstreamUserAgent = "";
  let appServerStderr = "";

  beforeAll(async () => {
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
    const initialized = await client.connect();
    upstreamUserAgent = initialized.userAgent;
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
    const threads = await client.listThreads(workdir);
    const archived = await client.listThreads(workdir, { archived: true });
    expect(Array.isArray(threads)).toBe(true);
    expect(Array.isArray(archived)).toBe(true);
    pino({ enabled: false }).info({ count: threads.length });
  });

  it("reports the upstream user agent used by Codex", () => {
    expect(upstreamUserAgent).toContain("codex_connect_gateway/");
  });

  it("reads account rate-limit snapshots without starting a turn", async () => {
    const result = await client.accountRateLimits();

    expect(result.rateLimits).toBeDefined();
    expect(result.rateLimits.primary === null || typeof result.rateLimits.primary.usedPercent === "number").toBe(true);
  });

  it("lists models with their supported reasoning efforts", async () => {
    const models = await client.listModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models.every((model) => model.supportedReasoningEfforts.length > 0)).toBe(true);
  });

  it("starts and unsubscribes a temporary thread without running a model turn", async () => {
    const started = await client.startThread(workdir);
    try {
      const unsubscribed = await client.unsubscribeThread(started.thread.id);

      expect(started.thread.id).toBeTruthy();
      expect(unsubscribed.status).toBe("unsubscribed");
    } finally {
      await client.deleteThread(started.thread.id);
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
      expect(restored.thread.id).toBe(threadId);
    } finally {
      if (archived) {
        await client.unarchiveThread(threadId);
      }
    }
  });
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

function appendDiagnostic(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-4_000);
}

function appServerFailure(message: string, stderr: string): string {
  const sanitized = stderr
    .replace(/(authorization|token|password|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .trim();
  return sanitized ? `${message}\nApp Server stderr:\n${sanitized}` : message;
}
