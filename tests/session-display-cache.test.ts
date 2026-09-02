import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteSessionDisplayCache } from "../src/storage/sqlite-session-display-cache.js";

const entries = new Set<SqliteSessionDisplayCache>();

afterEach(() => {
  for (const cache of entries) cache.close();
  entries.clear();
});

describe("SqliteSessionDisplayCache", () => {
  it("persists derived metadata and reuses updated turn counts", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-session-cache-"));
    const path = join(directory, "session-display-cache.sqlite3");
    const first = new SqliteSessionDisplayCache(path);
    entries.add(first);
    const entry = {
      threadId: "thread-1",
      workspaceId: "workspace-1",
      archived: false,
      preview: "测试会话",
      name: null,
      modelProvider: "openai",
      status: { type: "idle" as const },
      activeTurnId: null,
      isPinned: false,
      turnCount: 4,
      measuredAt: 123,
    };
    first.put(entry);
    first.close();
    entries.delete(first);

    const second = new SqliteSessionDisplayCache(path);
    entries.add(second);
    expect(second.get("thread-1")).toEqual(entry);
    second.invalidateTurnCount("thread-1");
    expect(second.get("thread-1")).toEqual({ ...entry, turnCount: null, measuredAt: null });
    second.remove("thread-1");
    expect(second.get("thread-1")).toBeUndefined();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects an incompatible schema instead of silently migrating it", () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-session-cache-"));
    const path = join(directory, "session-display-cache.sqlite3");
    const cache = new SqliteSessionDisplayCache(path);
    entries.add(cache);
    cache.close();
    entries.delete(cache);
    const database = new DatabaseSync(path);
    database.exec("PRAGMA user_version = 99;");
    database.close();
    expect(() => new SqliteSessionDisplayCache(path)).toThrow(/版本不兼容/u);
    rmSync(directory, { recursive: true, force: true });
  });
});
