import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { securePrivateFileSync } from "../runtime/private-file.mjs";

import { initializeUserData } from "../scripts/runtime-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { inspectStateDatabase, validateStateDatabaseStructure } from "../scripts/state-database.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("state database inspection", () => {
  it("rejects a current version whose required structure is incomplete", () => {
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
      CREATE TABLE conversation_bindings (surface TEXT);
      PRAGMA user_version = 5;
    `);
    database.close();

    expect(() => inspectStateDatabase(environment)).toThrow(
      /状态数据库结构不完整/u,
    );
  });

  it("fails state structure validation when the scheduled task schema is unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-state-upgrade-"));
    temporaryDirectories.push(home);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    initializeUserData({ environment, cwd: home });
    const dataDir = join(home, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });

    const statePath = join(dataDir, "gateway.sqlite3");
    const state = new DatabaseSync(statePath);
    state.exec(`
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
      CREATE TABLE conversation_actors (
        surface TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id, actor_id)
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
      CREATE TABLE conversation_idle_state (
        surface TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        last_activity_at INTEGER NOT NULL,
        force_new INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id)
      ) STRICT;
      PRAGMA user_version = 5;
    `);
    state.close();

    const scheduledPath = join(dataDir, "scheduled-tasks.sqlite3");
    const scheduled = new DatabaseSync(scheduledPath);
    scheduled.exec("PRAGMA user_version = 3;");
    scheduled.close();
    chmodSync(scheduledPath, 0o600);
    if (process.platform === "win32") securePrivateFileSync(scheduledPath);

    expect(() => validateStateDatabaseStructure(environment)).toThrow(/计划任务数据库 Schema 3/u);
  });
});
