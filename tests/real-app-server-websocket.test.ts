import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../src/codex-client/client.js";
import { toConversationInputEvent } from "../src/codex-client/index.js";
import { JsonRpcClient } from "../src/codex-client/json-rpc.js";
import { UnixWebSocketTransport } from "../src/codex-client/unix-websocket-transport.js";
import { appendDiagnostic, appServerFailure, waitFor } from "./support/real-app-server-helpers.js";

const run = process.env.RUN_CODEX_INTEGRATION === "1";
const suite = run ? describe : describe.skip;
const resumeFixtureThreadId = process.env.CODEX_RESUME_FIXTURE_THREAD_ID;
const archiveFixtureThreadId = process.env.CODEX_ARCHIVE_FIXTURE_THREAD_ID;
const resumeTest = run && resumeFixtureThreadId ? it : it.skip;
const forkTest = run && resumeFixtureThreadId ? it : it.skip;
const archiveTest = run && archiveFixtureThreadId ? it : it.skip;
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
