import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { upgradeStateDatabase } from "../scripts/upgrade-state.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("state database upgrade", () => {
  it("backs up and explicitly upgrades Schema 3 to Schema 4", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-state-upgrade-"));
    temporaryDirectories.push(home);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    initializeUserData({ environment, cwd: home });
    const databasePath = join(home, "data", "gateway.sqlite3");
    mkdirSync(join(home, "data"), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
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
      PRAGMA user_version = 3;
    `);
    database.close();

    const result = upgradeStateDatabase(environment);

    expect(result).toMatchObject({ changed: true, databasePath, version: 4 });
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    const upgraded = new DatabaseSync(databasePath);
    expect(upgraded.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    expect(upgraded.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'conversation_background_bindings'
    `).get()).toEqual({ name: "conversation_background_bindings" });
    upgraded.close();
  });
});
