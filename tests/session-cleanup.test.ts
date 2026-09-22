import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadSnapshot } from "../src/session-routing/index.js";

import {
  isThreadIdle,
  parseSessionCleanupArgs,
  runSessionCleanup,
} from "../scripts/session-cleanup.mjs";

type FixtureThread = ThreadSnapshot & { archived: boolean; turnCount: number };
const fixture = vi.hoisted(() => ({
  threads: new Map<string, FixtureThread>(),
  bound: new Set<string>(),
  gatewayActive: false,
  failHistory: new Set<string>(),
  retain: new Set<string>(),
  repeatedCursor: false,
  verifyFailure: false,
  requestFailure: false,
  lostResponse: false,
  startGatewayAfterArchive: false,
  failConnect: "",
  failList: "",
  historyCalls: [] as Array<{ provider: string; id: string }>,
  archives: [] as Array<{ provider: string; id: string }>,
  removedCache: [] as string[],
  databasePath: "data/gateway.sqlite3",
  cachePaths: [] as string[],
  closed: [] as string[],
  confirm: vi.fn(async () => true),
}));

vi.mock("../scripts/runtime-config.mjs", () => ({ requireUserConfig: () => ({ configPath: "/config.toml", dataDir: "/fixture" }) }));
vi.mock("../runtime/gateway-owner.mjs", () => ({ gatewayOwnerIsActive: async () => fixture.gatewayActive }));
vi.mock("../runtime/gateway-config.mjs", () => ({ readGatewayConfig: () => ({ codex: { binary: "codex" }, storage: { database_path: fixture.databasePath } }) }));
vi.mock("../scripts/workspace-config.mjs", () => ({ readWorkspaceConfig: () => ({ workspaces: [{ id: "project", cwd: "/workspace" }] }) }));
vi.mock("../runtime/app-server-runtime.mjs", () => ({ resolveAppServerRuntime: () => ({
  primaryProvider: "openai", primarySocketPath: "openai", managedProviders: [{ provider: "ds-test" }], managedSocketPaths: ["ds-test"],
}) }));
vi.mock("../runtime/app-server-supervisor.mjs", () => ({ ensureAppServerProvider: async () => {} }));
vi.mock("../runtime/executable.mjs", () => ({ effectiveCodexBinary: () => "codex", resolveExecutable: () => "codex", executableInvocation: () => ({}) }));
vi.mock("../runtime/process-lifecycle.mjs", () => ({ terminateChildProcess: () => {} }));
vi.mock("../scripts/terminal-prompter.mjs", () => ({ createPrompter: () => ({ confirm: fixture.confirm, close: () => {} }) }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("node:sqlite", () => ({ DatabaseSync: class {
  prepare() { return { all: () => [...fixture.bound].map((thread_id) => ({ thread_id })) }; }
  close() {}
} }));
vi.mock("../dist/storage/index.js", () => ({ SqliteSessionDisplayCache: class {
  constructor(path: string) { fixture.cachePaths.push(path); }
  remove(id: string) { fixture.removedCache.push(id); }
  close() {}
} }));
vi.mock("../dist/codex-client/index.js", () => {
  const descendants = (id: string): FixtureThread[] => [...fixture.threads.values()].filter((thread) => {
    let parent = thread.parentThreadId;
    while (parent) {
      if (parent === id) return true;
      parent = fixture.threads.get(parent)?.parentThreadId;
    }
    return false;
  });
  return {
    createAppServerTransport: (options: { socketPath: string }) => options.socketPath,
    JsonRpcClient: class { constructor(readonly provider: string) {} },
    CodexAppServerClient: class {
      constructor(readonly rpc: { provider: string }) {}
      async connect() { if (fixture.failConnect === this.rpc.provider) throw new Error("connect failed"); }
      async close() { fixture.closed.push(this.rpc.provider); }
      async listThreads(cwd: string, { archived = false } = {}) {
        if (fixture.failList === this.rpc.provider) throw new Error("list failed");
        if (fixture.verifyFailure && fixture.archives.length > 0) throw new Error("verification unavailable");
        return [...fixture.threads.values()].filter((thread) => !thread.parentThreadId && thread.cwd === cwd && thread.archived === archived);
      }
      async listThreadDescendants(id: string, archived: boolean) {
        return descendants(id).filter((thread) => thread.archived === archived);
      }
      async readThread(id: string) { return structuredClone(fixture.threads.get(id)); }
      async listThreadTurns(id: string) {
        fixture.historyCalls.push({ provider: this.rpc.provider, id });
        if (fixture.failHistory.has(id)) throw new Error("history unavailable");
        return {
          turns: Array.from({ length: fixture.threads.get(id)?.turnCount ?? 0 }, () => ({})),
          nextCursor: fixture.repeatedCursor ? "same" : null,
        };
      }
      async archiveThread(id: string) {
        fixture.archives.push({ provider: this.rpc.provider, id });
        if (fixture.requestFailure) throw new Error("archive rejected");
        for (const thread of [fixture.threads.get(id)!, ...descendants(id)]) {
          if (!fixture.retain.has(thread.id)) thread.archived = true;
        }
        if (fixture.startGatewayAfterArchive) fixture.gatewayActive = true;
        if (fixture.lostResponse) throw new Error("response lost");
      }
    },
  };
});

function addThread(id: string, overrides: Partial<FixtureThread> = {}): FixtureThread {
  const thread: FixtureThread = {
    id, sessionId: id, modelProvider: "ds-test", preview: "", name: id,
    isPinned: false, status: { type: "idle" }, cwd: "/workspace", source: "appServer",
    historyMode: "paginated", activeTurnId: null, updatedAt: 1, recencyAt: 1,
    archived: false, turnCount: 2, ...overrides,
  };
  fixture.threads.set(id, thread);
  return thread;
}

interface CleanupResult {
  candidates: Array<{ thread: ThreadSnapshot }>;
  skipped: Array<{ id: string; reason: string }>;
  results: Array<{ id: string; status: string; reason?: string }>;
}

async function cleanup(args = ["3", "--confirm"]): Promise<CleanupResult> {
  return await runSessionCleanup(args, { environment: {}, output: { log: () => {} } }) as CleanupResult;
}

const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
beforeAll(() => {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
});
afterAll(() => {
  if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
  else Reflect.deleteProperty(process.stdin, "isTTY");
  if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
  else Reflect.deleteProperty(process.stdout, "isTTY");
});
beforeEach(() => {
  fixture.threads.clear(); fixture.bound.clear(); fixture.failHistory.clear(); fixture.retain.clear();
  fixture.gatewayActive = false; fixture.repeatedCursor = false; fixture.verifyFailure = false; fixture.requestFailure = false;
  fixture.lostResponse = false; fixture.startGatewayAfterArchive = false; fixture.failConnect = ""; fixture.failList = "";
  fixture.historyCalls.length = 0; fixture.archives.length = 0; fixture.removedCache.length = 0; fixture.closed.length = 0;
  fixture.confirm.mockReset().mockResolvedValue(true);
  fixture.databasePath = "data/gateway.sqlite3"; fixture.cachePaths.length = 0;
});

describe("session cleanup CLI", () => {
  it.each([
    ["data/gateway.sqlite3", "/fixture/data/session-display-cache.sqlite3"],
    ["custom/state.sqlite3", "/fixture/custom/session-display-cache.sqlite3"],
    ["/custom/state.sqlite3", "/custom/session-display-cache.sqlite3"],
  ])("invalidates the cache beside database %s", async (databasePath, cachePath) => {
    fixture.databasePath = databasePath;
    addThread("parent");
    expect((await cleanup()).results).toMatchObject([{ status: "confirmed" }]);
    expect(fixture.cachePaths).toEqual([cachePath]);
    expect(fixture.removedCache).toEqual(["parent"]);
  });

  it.each(["connection", "listing"])("refuses incomplete %s and closes all clients", async (failure) => {
    addThread("parent");
    if (failure === "connection") fixture.failConnect = "ds-test";
    else fixture.failList = "ds-test";
    await expect(cleanup()).rejects.toThrow();
    expect(fixture.archives).toEqual([]);
    expect(fixture.closed.sort()).toEqual(["ds-test", "openai"]);
  });

  it("stops remaining groups when Gateway starts during execution", async () => {
    addThread("first"); addThread("second"); fixture.startGatewayAfterArchive = true;
    expect((await cleanup()).results).toMatchObject([
      { id: "first", status: "confirmed" }, { id: "second", status: "skipped" },
    ]);
    expect(fixture.archives.map((item) => item.id)).toEqual(["first"]);
  });

  it("verifies a lost write response rather than retrying the archive", async () => {
    addThread("parent"); fixture.lostResponse = true;
    expect((await cleanup()).results).toMatchObject([{ status: "confirmed", requestError: "response lost" }]);
    expect(fixture.archives).toHaveLength(1);
  });

  it("routes reads and one parent archive to the owning Provider and verifies descendants", async () => {
    addThread("parent");
    addThread("child", { parentThreadId: "parent", source: "other", turnCount: 100 });
    addThread("grandchild", { parentThreadId: "child", source: "other" });
    addThread("already-archived", { parentThreadId: "parent", archived: true });
    const result = await cleanup();
    expect(result.results).toMatchObject([{ id: "parent", status: "confirmed" }]);
    expect(fixture.archives).toEqual([{ provider: "ds-test", id: "parent" }]);
    expect(fixture.historyCalls.every((call) => call.provider === "ds-test" && call.id === "parent")).toBe(true);
    expect(fixture.removedCache.sort()).toEqual(["child", "grandchild", "parent"]);
    expect(fixture.closed.sort()).toEqual(["ds-test", "openai"]);
  });

  it.each([
    { isPinned: true }, { status: { type: "active" as const } },
    { archived: true, status: { type: "active" as const } },
    { cwd: "/outside" }, { modelProvider: "removed-provider" },
    { recencyAt: Math.floor(Date.now() / 1000) },
  ])("skips the parent when a descendant is protected: %j", async (overrides) => {
    addThread("parent"); addThread("child", { parentThreadId: "parent", ...overrides });
    const result = await cleanup(["3", "--idle-days", "30", "--confirm"]);
    expect(result.candidates).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(fixture.archives).toEqual([]);
  });

  it("continues after unreadable history and skips a bound descendant", async () => {
    addThread("unreadable"); addThread("bound-parent"); addThread("eligible");
    addThread("bound-child", { parentThreadId: "bound-parent" });
    fixture.failHistory.add("unreadable"); fixture.bound.add("bound-child");
    const result = await cleanup();
    expect(result.skipped).toHaveLength(2);
    expect(fixture.archives.map((item) => item.id)).toEqual(["eligible"]);
  });

  it("stops repeated history cursors without blocking other thread cleanup", async () => {
    addThread("parent", { turnCount: 0 }); fixture.repeatedCursor = true;
    const result = await cleanup();
    expect(result.skipped[0]?.reason).toContain("循环游标");
    expect(fixture.historyCalls).toHaveLength(2);
    expect(fixture.archives).toEqual([]);
  });

  it("stops counting as soon as the parent exceeds the threshold", async () => {
    addThread("parent", { turnCount: 4 }); fixture.repeatedCursor = true;
    expect((await cleanup()).candidates).toEqual([]);
    expect(fixture.historyCalls).toHaveLength(1);
  });

  it.each(["binding", "active", "new-child", "history", "gateway"])("rechecks %s after confirmation", async (change) => {
    const parent = addThread("parent");
    fixture.confirm.mockImplementationOnce(async () => {
      if (change === "binding") fixture.bound.add("parent");
      if (change === "active") parent.status = { type: "active" };
      if (change === "new-child") addThread("child", { parentThreadId: "parent" });
      if (change === "history") parent.turnCount = 3;
      if (change === "gateway") fixture.gatewayActive = true;
      return true;
    });
    expect((await cleanup()).results).toMatchObject([{ status: "skipped" }]);
    expect(fixture.archives).toEqual([]);
  });

  it.each(["preview", "cancel"])("does not archive during %s", async (mode) => {
    addThread("parent"); fixture.confirm.mockResolvedValueOnce(false);
    await cleanup(mode === "preview" ? ["3"] : ["3", "--confirm"]);
    expect(fixture.archives).toEqual([]);
    expect(fixture.removedCache).toEqual([]);
  });

  it("reports partial official success without retrying child archives", async () => {
    addThread("parent"); addThread("child", { parentThreadId: "parent" }); fixture.retain.add("child");
    expect((await cleanup()).results).toMatchObject([{ status: "partial", reason: "仍未归档：child" }]);
    expect(fixture.archives).toHaveLength(1);
    expect(fixture.removedCache).toEqual(["parent"]);
  });

  it.each(["verify", "request"])("reports %s failure without retrying writes", async (failure) => {
    addThread("parent");
    fixture.verifyFailure = failure === "verify"; fixture.requestFailure = failure === "request";
    expect((await cleanup()).results).toMatchObject([{ status: failure === "verify" ? "unconfirmed" : "failed" }]);
    expect(fixture.archives).toHaveLength(1);
  });

  it("parses the Turn, idle and confirmation options", () => {
    expect(parseSessionCleanupArgs(["3"])).toEqual({
      confirm: false,
      maxTurns: 3,
      idleDays: null,
    });
    expect(parseSessionCleanupArgs(["3", "--idle-days", "30", "--confirm"])).toEqual({
      confirm: true,
      maxTurns: 3,
      idleDays: 30,
    });
  });

  it("rejects malformed idle options", () => {
    expect(() => parseSessionCleanupArgs(["3", "--idle-days", "0"])).toThrow();
    expect(() => parseSessionCleanupArgs(["3", "--confirm", "--idle-days"])).toThrow();
  });

  it("prefers recencyAt and fails closed when activity metadata is absent", () => {
    expect(isThreadIdle({ recencyAt: 90, updatedAt: 10 }, 100)).toBe(true);
    expect(isThreadIdle({ recencyAt: 110, updatedAt: 10 }, 100)).toBe(false);
    expect(isThreadIdle({ recencyAt: null, updatedAt: 90 }, 100)).toBe(true);
    expect(isThreadIdle({}, 100)).toBe(false);
  });
});
