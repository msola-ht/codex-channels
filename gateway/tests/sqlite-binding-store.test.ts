import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CodexAppServerClient } from "../src/codex-client/client.js";
import { SessionRouter } from "../src/session-routing/router.js";
import { MemoryBindingStore } from "../src/storage/memory-binding-store.js";
import { SqliteBindingStore } from "../src/storage/sqlite-binding-store.js";
import { WorkspaceRegistry } from "../src/policy/workspace-registry.js";

const target = { surface: "telegram" as const, conversationId: "100" };
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
    second.unbind(target);
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
});

describe("MemoryBindingStore", () => {
  it("preserves the previous indexes when another conversation owns the requested thread", () => {
    const store = new MemoryBindingStore();
    const otherTarget = { surface: "telegram" as const, conversationId: "200" };
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
