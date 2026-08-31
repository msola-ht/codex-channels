import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";
import { securePrivateFileSync } from "../runtime/private-file.mjs";

import { initializeUserData } from "../scripts/runtime-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { inspectStateDatabase, upgradeStateDatabase, validateStateDatabaseStructure } from "../scripts/upgrade-state.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("state database upgrade", () => {
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
      PRAGMA user_version = 4;
    `);
    database.close();

    expect(() => inspectStateDatabase(environment)).toThrow(
      /状态数据库结构不完整/u,
    );
  });

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

  it("backs up and explicitly upgrades a v1 scheduled task database together with state", () => {
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
      PRAGMA user_version = 3;
    `);
    state.close();
    if (process.platform === "win32") securePrivateFileSync(statePath);

    const scheduledPath = join(dataDir, "scheduled-tasks.sqlite3");
    createScheduledTaskV1Database(scheduledPath);
    if (process.platform === "win32") securePrivateFileSync(scheduledPath);

    const before = inspectStateDatabase(environment);
    expect(before.scheduledTasks).toMatchObject({
      compatible: false,
      exists: true,
      schemaVersion: 1,
      updateable: true,
    });

    const result = upgradeStateDatabase(environment);
    expect(result).toMatchObject({ changed: true, databasePath: statePath, version: 4 });
    expect(result.scheduledTasks).toMatchObject({
      changed: true,
      databasePath: scheduledPath,
      version: 2,
    });
    expect(result.scheduledTasks?.backupPath && existsSync(result.scheduledTasks.backupPath)).toBe(true);

    const upgradedState = new DatabaseSync(statePath);
    expect(upgradedState.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    upgradedState.close();

    const upgradedTaskDb = new DatabaseSync(scheduledPath);
    expect(upgradedTaskDb.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(upgradedTaskDb.prepare(`
      SELECT schedule_type, CAST(schedule_json AS TEXT) AS schedule_json
      FROM tasks WHERE task_id = 'v1-hourly'
    `).get()).toMatchObject({
      schedule_type: "interval",
      schedule_json: JSON.stringify({
        type: "interval",
        intervalMinutes: 60,
        anchorAt: Date.parse("2026-01-01T00:00:00.000Z"),
      }),
    });
    const foreignKeys = upgradedTaskDb.prepare("PRAGMA foreign_key_list(runs)").all() as Array<{ table: string }>;
    expect(foreignKeys.some((entry) => entry.table === "tasks")).toBe(true);
    expect(upgradedTaskDb.prepare("SELECT COUNT(*) AS count FROM runs").get()).toEqual({ count: 1 });
    upgradedTaskDb.close();
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
      PRAGMA user_version = 4;
    `);
    state.close();

    const scheduledPath = join(dataDir, "scheduled-tasks.sqlite3");
    const scheduled = new DatabaseSync(scheduledPath);
    scheduled.exec("PRAGMA user_version = 3;");
    scheduled.close();
    chmodSync(scheduledPath, 0o600);
    if (process.platform === "win32") securePrivateFileSync(scheduledPath);

    expect(() => validateStateDatabaseStructure(environment)).toThrow(/计划任务数据库 Schema 3/u);
    expect(() => upgradeStateDatabase(environment)).toThrow(/计划任务数据库 Schema 3/u);
  });
});

function createScheduledTaskV1Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE schema_metadata (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    ) STRICT;
    INSERT INTO schema_metadata (name, value) VALUES ('schema_version', 1);
    CREATE TABLE tasks (
      task_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'blocked', 'deleted')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      surface TEXT NOT NULL,
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT CHECK (
        schedule_type IS NULL OR schedule_type IN ('hourly', 'daily', 'weekdays', 'weekly')
      ),
      schedule_json TEXT,
      timezone TEXT,
      anchor_at INTEGER,
      next_run_at INTEGER,
      model_provider TEXT,
      model TEXT,
      reasoning_effort TEXT,
      service_tier TEXT,
      sandbox TEXT CHECK (sandbox IS NULL OR sandbox IN ('read-only', 'workspace-write')),
      approval_policy TEXT CHECK (approval_policy IS NULL OR approval_policy = 'never'),
      permissions TEXT
    ) STRICT;
    CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(task_id),
      scheduled_for INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN (
          'dispatching', 'running', 'completed', 'failed', 'interrupted',
          'uncertain', 'missed', 'skipped_overlap', 'skipped_capacity', 'blocked'
        )
      ),
      thread_id TEXT,
      turn_id TEXT,
      dispatch_started_at INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      error_category TEXT CHECK (
        error_category IS NULL OR error_category IN (
          'authorization', 'workspace', 'provider', 'model', 'approval', 'capacity',
          'overlap', 'missed', 'interrupted', 'gateway_crash', 'unknown'
        )
      ),
      error_message TEXT,
      UNIQUE (task_id, scheduled_for)
    ) STRICT;
    CREATE INDEX tasks_due_idx ON tasks(status, next_run_at, task_id);
    PRAGMA user_version = 1;
  `);
  const anchorAt = Date.parse("2026-01-01T00:00:00.000Z");
  db.prepare(`
    INSERT INTO tasks (
      task_id, name, status, created_at, updated_at,
      surface, account_id, conversation_id, actor_id, workspace_id, prompt,
      schedule_type, schedule_json, timezone, anchor_at, next_run_at,
      model_provider, model, reasoning_effort, service_tier,
      sandbox, approval_policy, permissions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "v1-hourly", "每小时", "active", anchorAt, anchorAt,
    "telegram", "default", "conversation-1", "actor-1", "workspace-1", "read",
    "hourly", JSON.stringify({ type: "hourly", intervalHours: 1, anchorAt }), "UTC",
    anchorAt, anchorAt + 60 * 60_000,
    null, null, null, null, "read-only", "never", null,
  );
  db.prepare(`
    INSERT INTO runs (run_id, task_id, scheduled_for, state) VALUES (?, ?, ?, ?)
  `).run("run-1", "v1-hourly", anchorAt, "completed");
  db.close();
  chmodSync(path, 0o600);
}
