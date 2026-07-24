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
const runContract = process.env.RUN_CODEX_CONTRACT === "1";
const contractSuite = runContract ? describe : describe.skip;
const archiveFixtureThreadId = process.env.CODEX_ARCHIVE_FIXTURE_THREAD_ID;
const archiveTest = run && archiveFixtureThreadId ? it : it.skip;
const resumeFixtureThreadId = process.env.CODEX_RESUME_FIXTURE_THREAD_ID;
const resumeTest = run && resumeFixtureThreadId ? it : it.skip;

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
      rmSync(testRuntime, { recursive: true, force: true });
    }
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

  it("lists installed plugins without loading remote catalog entries", async () => {
    const result = await client.listPlugins(workdir);
    const plugins = result.marketplaces.flatMap((marketplace) => marketplace.plugins);

    expect(plugins.every((plugin) => plugin.installed)).toBe(true);
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
      const loaded = await peerRpc.request<{ data: string[] }>(
        "thread/loaded/list",
        { limit: 100 },
        { retryOverload: true },
      );
      const ownerUnsubscribed = await client.unsubscribeThread(started.thread.id);

      expect(started.thread.id).toBeTruthy();
      expect(observedThreadId).toBe(started.thread.id);
      expect(loaded.data).toContain(started.thread.id);
      expect(ownerUnsubscribed.status).toBe("unsubscribed");
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
  let ownerClient: CodexAppServerClient;
  let peerRpc: JsonRpcClient;
  let peerClient: CodexAppServerClient;
  let appServerStderr = "";

  beforeAll(async () => {
    mkdirSync(runtimeRoot, { recursive: true });
    testRuntime = mkdtempSync(join(runtimeRoot, "contract-"));
    codexHome = join(testRuntime, "codex-home");
    socketPath = join(testRuntime, "app-server.sock");
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
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
      () => processHandle.exitCode === null
        ? undefined
        : new Error(appServerFailure("隔离 Codex App Server 在创建 Unix Socket 前退出", appServerStderr)),
    );
    ownerClient = new CodexAppServerClient(
      new JsonRpcClient(new UnixWebSocketTransport(socketPath)),
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
    if (processHandle?.exitCode === null) {
      processHandle.kill("SIGTERM");
      await new Promise((resolveExit) => processHandle.once("exit", resolveExit));
    }
    if (testRuntime) {
      rmSync(testRuntime, { recursive: true, force: true });
    }
  });

  it("persists Fast defaults for peer reads and subsequently started threads", async () => {
    const startedThreadIds: string[] = [];
    try {
      await ownerClient.writeDefaultFastMode(false);
      await expectConfiguredTier(peerClient, workdir, "default");
      const standardThread = await ownerClient.startThread(workdir);
      startedThreadIds.push(standardThread.thread.id);
      expect(standardThread.serviceTier).toBe("default");

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

  it("broadcasts peer Fast setting changes to another subscribed client", async () => {
    const observedTiers: unknown[] = [];
    const removeNotification = ownerClient.onNotification((notification) => {
      if (notification.method !== "thread/settings/updated") {
        return;
      }
      const params = notification.params as {
        threadId?: unknown;
        threadSettings?: { serviceTier?: unknown };
      };
      if (params.threadId === threadId) {
        observedTiers.push(params.threadSettings?.serviceTier);
      }
    });
    const started = await ownerClient.startThread(workdir);
    const threadId = started.thread.id;
    try {
      await peerRpc.request("thread/settings/update", {
        threadId,
        serviceTier: "priority",
      });
      await waitFor(() => observedTiers.includes("priority"), 2_000);

      await peerRpc.request("thread/settings/update", {
        threadId,
        serviceTier: "default",
      });
      await waitFor(() => observedTiers.includes("default"), 2_000);
    } finally {
      removeNotification();
      await ownerClient.unsubscribeThread(threadId).catch(() => undefined);
      await ownerClient.deleteThread(threadId);
    }
  }, 15_000);
});

async function expectConfiguredTier(
  client: CodexAppServerClient,
  cwd: string,
  expected: string,
): Promise<void> {
  const result = await client.readConfig(cwd);
  expect(result.config.service_tier).toBe(expected);
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

function appendDiagnostic(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-4_000);
}

function appServerFailure(message: string, stderr: string): string {
  const sanitized = stderr
    .replace(/(authorization|token|password|cookie)(\s*[:=]\s*)\S+/gi, "$1$2[REDACTED]")
    .trim();
  return sanitized ? `${message}\nApp Server stderr:\n${sanitized}` : message;
}
