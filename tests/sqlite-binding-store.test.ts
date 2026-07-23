import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexAppServerClient } from "../src/codex-client/client.js";
import { SessionRouter } from "../src/session-routing/router.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import {
  SqliteBindingStore,
  v2MigrationBackupPath,
} from "../src/storage/sqlite-binding-store.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";

const target = { surface: "telegram" as const, accountId: "default", conversationId: "100" };
const registry = new WorkspaceRegistry([{ id: "main", name: "Main", cwd: "/workspace" }], "main");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteBindingStore", () => {
  it("persists only the current conversation binding with private permissions", () => {
    const { path } = databasePath();
    const first = new SqliteBindingStore(path);
    first.bind({ target, workspaceId: "main", threadId: "thread-1", sessionId: "session-1" });
    first.rememberActor(target, "123");

    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
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
    const client = {
      resumeThread: async () => {
        throw new Error("thread not found");
      },
    } as unknown as CodexAppServerClient;
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

  it("migrates v2 Telegram bindings to the default account without data loss", () => {
    const { directory } = databasePath();
    const path = join(directory, "gateway-v2.sqlite3");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE conversation_workspaces (
        surface TEXT NOT NULL CHECK (surface = 'telegram'),
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (surface, conversation_id)
      ) STRICT;
      CREATE TABLE conversation_bindings (
        surface TEXT NOT NULL CHECK (surface = 'telegram'),
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (surface, conversation_id)
      ) STRICT;
      INSERT INTO conversation_workspaces VALUES ('telegram', '100', 'main', 1);
      INSERT INTO conversation_bindings
      VALUES ('telegram', '100', 'main', 'thread-v2', 'session-v2', 1);
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = new SqliteBindingStore(path);

    expect(migrated.get(target)).toEqual({
      target,
      workspaceId: "main",
      threadId: "thread-v2",
      sessionId: "session-v2",
    });
    expect(migrated.actors(target)).toEqual([]);
    migrated.close();
    const backupPath = v2MigrationBackupPath(path);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    expect((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(2);
    expect(
      (backup.prepare("SELECT thread_id FROM conversation_bindings").get() as { thread_id: string })
        .thread_id,
    ).toBe("thread-v2");
    backup.close();
    const verified = new DatabaseSync(path);
    expect((verified.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(3);
    verified.close();
  });

  it("refuses migration when an existing v2 backup belongs to different data", () => {
    const { directory } = databasePath();
    const path = join(directory, "gateway-v2.sqlite3");
    createV2Database(path, "thread-current");
    createV2Database(v2MigrationBackupPath(path), "thread-stale");

    expect(() => new SqliteBindingStore(path)).toThrow(
      "SQLite v2 迁移备份与当前数据库不一致",
    );

    const current = new DatabaseSync(path);
    expect((current.prepare("PRAGMA user_version").get() as { user_version: number }).user_version)
      .toBe(2);
    expect(
      (current.prepare("SELECT thread_id FROM conversation_bindings").get() as {
        thread_id: string;
      }).thread_id,
    ).toBe("thread-current");
    current.close();
  });
});

describe("MemoryBindingStore", () => {
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

function createV2Database(path: string, threadId: string): void {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE conversation_workspaces (
      surface TEXT NOT NULL CHECK (surface = 'telegram'),
      conversation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (surface, conversation_id)
    ) STRICT;
    CREATE TABLE conversation_bindings (
      surface TEXT NOT NULL CHECK (surface = 'telegram'),
      conversation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (surface, conversation_id)
    ) STRICT;
    INSERT INTO conversation_workspaces VALUES ('telegram', '100', 'main', 1);
    INSERT INTO conversation_bindings
    VALUES ('telegram', '100', 'main', '${threadId}', 'session-v2', 1);
    PRAGMA user_version = 2;
  `);
  database.close();
}
