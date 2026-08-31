import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  SessionRouter,
  type ThreadLifecyclePort,
} from "../src/session-routing/index.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";
import {
  MemoryBindingStore,
  SqliteBindingStore,
} from "../src/storage/index.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const registry = new WorkspaceRegistry([{ id: "main", name: "Main", cwd: "/workspace" }], "main");
const temporaryDirectories: string[] = [];

function threadPort(overrides: Partial<ThreadLifecyclePort> = {}): ThreadLifecyclePort {
  const unsupported = async (): Promise<never> => {
    throw new Error("测试未配置 ThreadLifecyclePort 方法");
  };
  return {
    listThreads: unsupported,
    readThread: unsupported,
    startThread: unsupported,
    resumeThread: unsupported,
    forkThread: unsupported,
    archiveThread: unsupported,
    unarchiveThread: unsupported,
    unsubscribeThread: unsupported,
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteBindingStore", () => {
  it("persists foreground and background bindings independently", () => {
    const { path } = databasePath();
    const first = new SqliteBindingStore(path);
    first.bind({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" });
    const switched = first.switchForeground(
      { target, workspaceId: "main", threadId: "thread-2", sessionId: "session-2" },
      true,
    );

    expect(switched.backgrounded?.threadId).toBe("thread-1");
    expect(first.get(target)?.threadId).toBe("thread-2");
    expect(first.backgrounds(target).map(({ threadId }) => threadId)).toEqual(["thread-1"]);
    first.close();

    const reopened = new SqliteBindingStore(path);
    expect(reopened.get(target)?.threadId).toBe("thread-2");
    expect(reopened.backgrounds(target).map(({ threadId }) => threadId)).toEqual(["thread-1"]);
    expect(reopened.isBackground("thread-1")).toBe(true);
    expect(reopened.list()).toHaveLength(2);
    reopened.removeThread("thread-1");
    expect(reopened.getByThread("thread-1")).toBeUndefined();
    reopened.close();
  });

  it("atomically transfers a Thread binding and persists the replaced destination", () => {
    const { path } = databasePath();
    const destination = {
      surface: "feishu" as const,
      accountId: "tenant-a",
      conversationId: "chat-a",
    };
    const store = new SqliteBindingStore(path);
    store.bind({
      target,
      workspaceId: "main",
      threadId: "thread-owned",
      sessionId: "session-owned",
    });
    store.bind({
      target: destination,
      workspaceId: "main",
      threadId: "thread-replaced",
      sessionId: "session-replaced",
    });

    const transfer = store.transfer("thread-owned", destination);

    expect(transfer.previousOwner.target).toEqual(target);
    expect(transfer.replaced?.threadId).toBe("thread-replaced");
    expect(store.get(target)).toBeUndefined();
    expect(store.get(destination)).toMatchObject({
      threadId: "thread-owned",
      sessionId: "session-owned",
    });
    expect(store.getByThread("thread-replaced")).toBeUndefined();
    store.close();

    const reopened = new SqliteBindingStore(path);
    expect(reopened.get(target)).toBeUndefined();
    expect(reopened.get(destination)?.threadId).toBe("thread-owned");
    expect(reopened.getByThread("thread-replaced")).toBeUndefined();
    reopened.close();
  });

  it("persists only the current conversation binding with private permissions", () => {
    const { path } = databasePath();
    const first = new SqliteBindingStore(path);
    first.bind({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" });
    first.rememberActor(target, "123");

    if (process.platform !== "win32") {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    first.close();

    const second = new SqliteBindingStore(path);
    expect(second.get(target)).toEqual({
      target,
      workspaceId: "main",
      threadId: "thread-1",
      sessionId: "session-1",
    });
    expect(second.actors(target)).toEqual(["123"]);
    expect(second.retainActors(target, new Set())).toBe(true);
    expect(second.actors(target)).toEqual([]);
    expect(second.get(target)).toBeUndefined();
    second.close();

    const third = new SqliteBindingStore(path);
    expect(third.list()).toEqual([]);
    third.close();
  });

  it("removes a persisted binding when its Codex Thread can no longer be resumed", async () => {
    const { path } = databasePath();
    const first = new SqliteBindingStore(path);
    first.bind({ target, workspaceId: "main", threadId: "missing-thread", sessionId: "missing-thread" });
    first.close();

    const second = new SqliteBindingStore(path);
    const client = threadPort({
      resumeThread: async () => {
        throw new Error("thread not found");
      },
    });
    const router = new SessionRouter(client, second, registry);

    const failures = await router.restoreSubscriptions();

    expect(failures).toHaveLength(1);
    expect(failures[0]?.bindingRemoved).toBe(true);
    expect(second.list()).toEqual([]);
    second.close();

    const third = new SqliteBindingStore(path);
    expect(third.list()).toEqual([]);
    third.close();
  });

  it("persists the selected workspace even when no thread is bound", () => {
    const { path } = databasePath();
    const first = new SqliteBindingStore(path);
    first.selectWorkspace(target, "other");
    first.close();

    const second = new SqliteBindingStore(path);
    expect(second.getWorkspace(target)).toBe("other");
    expect(second.get(target)).toBeUndefined();
    second.close();
  });

  it("keeps an authorized conversation discoverable after its Thread is unbound", () => {
    const { path } = databasePath();
    const first = new SqliteBindingStore(path);
    first.selectWorkspace(target, "main");
    first.rememberActor(target, "123");
    first.bind({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" });
    first.unbind(target);

    expect(first.conversations()).toEqual([target]);
    first.close();

    const reopened = new SqliteBindingStore(path);
    expect(reopened.conversations()).toEqual([target]);
    expect(reopened.get(target)).toBeUndefined();
    reopened.close();
  });

  it("isolates identical conversation IDs across Surface accounts", () => {
    const { path } = databasePath();
    const store = new SqliteBindingStore(path);
    const feishu = {
      surface: "feishu" as const,
      accountId: "tenant-a",
      conversationId: "100",
    };
    const wechat = {
      surface: "wechat" as const,
      accountId: "corp-a",
      conversationId: "100",
    };
    store.bind({
      target,
      workspaceId: "main",
      threadId: "telegram-thread",
      sessionId: "telegram-session",
    });
    store.bind({
      target: feishu,
      workspaceId: "main",
      threadId: "feishu-thread",
      sessionId: "feishu-session",
    });
    store.bind({
      target: wechat,
      workspaceId: "main",
      threadId: "wechat-thread",
      sessionId: "wechat-session",
    });

    expect(store.get(target)?.threadId).toBe("telegram-thread");
    expect(store.get(feishu)?.threadId).toBe("feishu-thread");
    expect(store.get(wechat)?.threadId).toBe("wechat-thread");
    store.close();
  });

  it("rejects a database created with an unsupported schema version", () => {
    const { directory } = databasePath();
    const path = join(directory, "gateway-v2.sqlite3");
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 2;");
    database.close();

    expect(() => new SqliteBindingStore(path)).toThrow(
      "状态数据库版本不兼容：当前 2，Gateway 需要 4",
    );
  });

  it("rejects a current-version database with an incomplete schema", () => {
    const { path } = databasePath();
    mkdirSync(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE conversation_workspaces (
        surface TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id)
      ) STRICT;

      CREATE TABLE conversation_bindings (
        surface TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id)
      ) STRICT;

      CREATE TABLE conversation_background_bindings (
        surface TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      PRAGMA user_version = 4;
    `);
    database.close();

    const openAndClose = (): void => {
      const store = new SqliteBindingStore(path);
      store.close();
    };
    expect(openAndClose).toThrow();

    const inspection = new DatabaseSync(path);
    expect(
      inspection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("conversation_actors"),
    ).toBeUndefined();
    inspection.close();
  });

  it("restores memory and persisted indexes when a binding transaction fails", () => {
    const { path } = databasePath();
    const store = new SqliteBindingStore(path);
    const previous = {
      target,
      workspaceId: "main",
      threadId: "thread-1",
      sessionId: "session-1",
    };
    store.bind(previous);

    const external = new DatabaseSync(path);
    external
      .prepare(`
        INSERT INTO conversation_bindings (
          surface, account_id, conversation_id, workspace_id, thread_id, session_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run("telegram", "default", "200", "main", "thread-2", "session-2", Date.now());
    external.close();

    expect(() => store.bind({
      ...previous,
      threadId: "thread-2",
      sessionId: "replacement-session",
    })).toThrow();
    expect(store.get(target)).toEqual(previous);
    expect(store.getByThread("thread-1")).toEqual(previous);
    expect(store.getByThread("thread-2")).toBeUndefined();
    store.close();

    const reopened = new SqliteBindingStore(path);
    expect(reopened.get(target)).toEqual(previous);
    expect(reopened.getByThread("thread-1")).toEqual(previous);
    expect(reopened.getByThread("thread-2")?.target.conversationId).toBe("200");
    reopened.close();
  });
});

describe("MemoryBindingStore", () => {
  it("promotes one background binding while demoting the active foreground", () => {
    const store = new MemoryBindingStore();
    const first = { target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" };
    const second = { target, workspaceId: "main", threadId: "thread-2", sessionId: "session-2" };
    store.bind(first);
    store.switchForeground(second, true);
    store.switchForeground(first, true);

    expect(store.get(target)).toEqual(first);
    expect(store.backgrounds(target)).toEqual([second]);
    expect(store.getByThread("thread-1")).toEqual(first);
    expect(store.getByThread("thread-2")).toEqual(second);
  });

  it("moves one Thread between conversations while releasing the destination binding", () => {
    const store = new MemoryBindingStore();
    const destination = {
      surface: "weixin" as const,
      accountId: "bot-a",
      conversationId: "user-a",
    };
    store.bind({
      target,
      workspaceId: "main",
      threadId: "thread-owned",
      sessionId: "session-owned",
    });
    store.bind({
      target: destination,
      workspaceId: "main",
      threadId: "thread-replaced",
      sessionId: "session-replaced",
    });

    const transfer = store.transfer("thread-owned", destination);

    expect(transfer.previousOwner.target).toEqual(target);
    expect(transfer.replaced?.threadId).toBe("thread-replaced");
    expect(store.get(target)).toBeUndefined();
    expect(store.get(destination)?.threadId).toBe("thread-owned");
    expect(store.getByThread("thread-replaced")).toBeUndefined();
  });

  it("tracks authorized Actors independently from Conversation identity", () => {
    const store = new MemoryBindingStore();
    store.rememberActor(target, "123");
    store.rememberActor(target, "456");
    store.rememberActor(target, "123");

    expect(store.actors(target)).toEqual(["123", "456"]);
    store.forgetActor(target, "123");
    expect(store.actors(target)).toEqual(["456"]);
  });

  it("does not collide when account or conversation IDs contain separators", () => {
    const store = new MemoryBindingStore();
    const first = {
      surface: "telegram",
      accountId: "a:b",
      conversationId: "c",
    };
    const second = {
      surface: "telegram",
      accountId: "a",
      conversationId: "b:c",
    };
    store.bind({
      target: first,
      workspaceId: "main",
      threadId: "thread-first",
      sessionId: "session-first",
    });
    store.bind({
      target: second,
      workspaceId: "main",
      threadId: "thread-second",
      sessionId: "session-second",
    });

    expect(store.get(first)?.threadId).toBe("thread-first");
    expect(store.get(second)?.threadId).toBe("thread-second");
  });

  it("preserves the previous indexes when another conversation owns the requested thread", () => {
    const store = new MemoryBindingStore();
    const otherTarget = { surface: "telegram" as const, accountId: "default", conversationId: "200" };
    const previous = { target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" };
    const other = { target: otherTarget, workspaceId: "main", threadId: "thread-2", sessionId: "session-2" };
    store.bind(previous);
    store.bind(other);

    expect(() => store.bind({ ...previous, threadId: "thread-2" }))
      .toThrow("该 Codex Thread 已绑定到其他会话");
    expect(store.get(target)).toEqual(previous);
    expect(store.getByThread("thread-1")).toEqual(previous);
    expect(store.getByThread("thread-2")).toEqual(other);
  });
});

function databasePath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "codex-gateway-state-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "private", "gateway.sqlite3") };
}
