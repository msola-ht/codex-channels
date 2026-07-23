import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConversationTarget, SurfaceId } from "../conversation-core/index.js";
import type { BindingStore, ConversationBinding } from "./binding-store.js";
import { MemoryBindingStore } from "./memory-binding-store.js";

interface BindingRow {
  surface: string;
  account_id: string;
  conversation_id: string;
  workspace_id: string;
  thread_id: string;
  session_id: string;
}

interface WorkspaceRow {
  surface: string;
  account_id: string;
  conversation_id: string;
  workspace_id: string;
}

interface ActorRow {
  surface: string;
  account_id: string;
  conversation_id: string;
  actor_id: string;
}

const schemaVersion = 3;

export function v2MigrationBackupPath(databasePath: string): string {
  return `${databasePath}.v2-backup`;
}

export class SqliteBindingStore implements BindingStore {
  private readonly database: DatabaseSync;
  private readonly memory = new MemoryBindingStore();
  private closed = false;

  constructor(readonly path: string) {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.database = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;");
      this.migrate();
      this.load();
    } catch (error) {
      try {
        this.database.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "状态数据库初始化和清理均失败",
          { cause: closeError },
        );
      }
      throw error;
    }
  }

  actors(target: ConversationTarget): string[] {
    return this.memory.actors(target);
  }

  rememberActor(target: ConversationTarget, actorId: string): void {
    this.requireOpen();
    if (!actorId) {
      throw new Error("Actor ID 不能为空");
    }
    if (this.memory.actors(target).includes(actorId)) {
      return;
    }
    this.database
      .prepare(`
        INSERT OR IGNORE INTO conversation_actors (
          surface, account_id, conversation_id, actor_id, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(target.surface, target.accountId, target.conversationId, actorId, Date.now());
    this.memory.rememberActor(target, actorId);
  }

  forgetActor(target: ConversationTarget, actorId: string): void {
    this.requireOpen();
    this.database
      .prepare(`
        DELETE FROM conversation_actors
        WHERE surface = ? AND account_id = ? AND conversation_id = ? AND actor_id = ?
      `)
      .run(target.surface, target.accountId, target.conversationId, actorId);
    this.memory.forgetActor(target, actorId);
  }

  retainActors(target: ConversationTarget, actorIds: ReadonlySet<string>): boolean {
    this.requireOpen();
    const knownActorIds = this.memory.actors(target);
    const removedActorIds = knownActorIds.filter((actorId) => !actorIds.has(actorId));
    const bindingRemoved = knownActorIds.every((actorId) => !actorIds.has(actorId))
      && this.memory.get(target) !== undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removeActor = this.database.prepare(`
        DELETE FROM conversation_actors
        WHERE surface = ? AND account_id = ? AND conversation_id = ? AND actor_id = ?
      `);
      for (const actorId of removedActorIds) {
        removeActor.run(target.surface, target.accountId, target.conversationId, actorId);
      }
      if (bindingRemoved) {
        this.database
          .prepare(`
            DELETE FROM conversation_bindings
            WHERE surface = ? AND account_id = ? AND conversation_id = ?
          `)
          .run(target.surface, target.accountId, target.conversationId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    for (const actorId of removedActorIds) {
      this.memory.forgetActor(target, actorId);
    }
    if (bindingRemoved) {
      this.memory.unbind(target);
    }
    return bindingRemoved;
  }

  getWorkspace(target: ConversationTarget): string | undefined {
    return this.memory.getWorkspace(target);
  }

  selectWorkspace(target: ConversationTarget, workspaceId: string): void {
    this.requireOpen();
    const binding = this.memory.get(target);
    if (binding && binding.workspaceId !== workspaceId) {
      throw new Error("切换 Workspace 前必须先解除当前 Thread 绑定");
    }
    this.database
      .prepare(`
        INSERT INTO conversation_workspaces (
          surface, account_id, conversation_id, workspace_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(surface, account_id, conversation_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          updated_at = excluded.updated_at
      `)
      .run(target.surface, target.accountId, target.conversationId, workspaceId, Date.now());
    this.memory.selectWorkspace(target, workspaceId);
  }

  get(target: ConversationTarget): ConversationBinding | undefined {
    return this.memory.get(target);
  }

  getByThread(threadId: string): ConversationBinding | undefined {
    return this.memory.getByThread(threadId);
  }

  list(): ConversationBinding[] {
    return this.memory.list();
  }

  bind(binding: ConversationBinding): void {
    this.requireOpen();
    const previous = this.memory.get(binding.target);
    const previousWorkspace = this.memory.getWorkspace(binding.target);
    this.memory.bind(binding);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare(`
          INSERT INTO conversation_workspaces (
            surface, account_id, conversation_id, workspace_id, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(surface, account_id, conversation_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            updated_at = excluded.updated_at
        `)
        .run(
          binding.target.surface,
          binding.target.accountId,
          binding.target.conversationId,
          binding.workspaceId,
          Date.now(),
        );
      this.database
        .prepare(`
          INSERT INTO conversation_bindings (
            surface, account_id, conversation_id, workspace_id, thread_id, session_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(surface, account_id, conversation_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            thread_id = excluded.thread_id,
            session_id = excluded.session_id,
            updated_at = excluded.updated_at
        `)
        .run(
          binding.target.surface,
          binding.target.accountId,
          binding.target.conversationId,
          binding.workspaceId,
          binding.threadId,
          binding.sessionId,
          Date.now(),
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      this.memory.unbind(binding.target);
      if (previous) {
        this.memory.bind(previous);
      } else if (previousWorkspace) {
        this.memory.selectWorkspace(binding.target, previousWorkspace);
      }
      throw error;
    }
  }

  unbind(target: ConversationTarget): ConversationBinding | undefined {
    this.requireOpen();
    const binding = this.memory.get(target);
    if (!binding) {
      return undefined;
    }
    this.database
      .prepare(`
        DELETE FROM conversation_bindings
        WHERE surface = ? AND account_id = ? AND conversation_id = ?
      `)
      .run(target.surface, target.accountId, target.conversationId);
    return this.memory.unbind(target);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
    this.memory.close();
  }

  private migrate(): void {
    const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === schemaVersion) {
      this.createActorSchema();
      return;
    }
    if (row.user_version === 2) {
      this.migrateV2();
      return;
    }
    if (row.user_version !== 0) {
      throw new Error(
        `状态数据库版本不兼容：当前 ${row.user_version}，Gateway 需要 ${schemaVersion}。开发期间请删除旧状态数据库后重启`,
      );
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.createSchema();
      this.database.exec(`PRAGMA user_version = ${schemaVersion}; COMMIT;`);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateV2(): void {
    this.ensureV2Backup();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        ALTER TABLE conversation_workspaces RENAME TO conversation_workspaces_v2;
        ALTER TABLE conversation_bindings RENAME TO conversation_bindings_v2;
      `);
      this.createSchema();
      this.database.exec(`
        INSERT INTO conversation_workspaces (
          surface, account_id, conversation_id, workspace_id, updated_at
        )
        SELECT surface, 'default', conversation_id, workspace_id, updated_at
        FROM conversation_workspaces_v2;

        INSERT INTO conversation_bindings (
          surface, account_id, conversation_id, workspace_id, thread_id, session_id, updated_at
        )
        SELECT surface, 'default', conversation_id, workspace_id, thread_id, session_id, updated_at
        FROM conversation_bindings_v2;

        DROP TABLE conversation_bindings_v2;
        DROP TABLE conversation_workspaces_v2;
        PRAGMA user_version = ${schemaVersion};
        COMMIT;
      `);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE conversation_workspaces (
        surface TEXT NOT NULL CHECK (length(surface) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id)
      ) STRICT;

      CREATE TABLE conversation_bindings (
        surface TEXT NOT NULL CHECK (length(surface) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id)
      ) STRICT;
    `);
    this.createActorSchema();
  }

  private createActorSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversation_actors (
        surface TEXT NOT NULL CHECK (length(surface) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        conversation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id, actor_id)
      ) STRICT;
    `);
  }

  private ensureV2Backup(): void {
    const backupPath = v2MigrationBackupPath(this.path);
    if (!existsSync(backupPath)) {
      this.database.prepare("VACUUM INTO ?").run(backupPath);
    }
    const backupStat = lstatSync(backupPath);
    if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
      throw new Error("SQLite v2 迁移备份路径必须是普通文件");
    }
    chmodSync(backupPath, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const row = backup.prepare("PRAGMA user_version").get() as { user_version: number };
      if (row.user_version !== 2) {
        throw new Error(`SQLite v2 迁移备份版本无效：${row.user_version}`);
      }
      if (!sameV2Data(this.database, backup)) {
        throw new Error("SQLite v2 迁移备份与当前数据库不一致");
      }
    } finally {
      backup.close();
    }
  }

  private load(): void {
    const workspaces = this.database
      .prepare(`
        SELECT surface, account_id, conversation_id, workspace_id
        FROM conversation_workspaces
        ORDER BY updated_at ASC
      `)
      .all() as unknown as WorkspaceRow[];
    for (const row of workspaces) {
      this.memory.selectWorkspace(
        {
          surface: parseSurfaceId(row.surface),
          accountId: row.account_id,
          conversationId: row.conversation_id,
        },
        row.workspace_id,
      );
    }
    const rows = this.database
      .prepare(`
        SELECT surface, account_id, conversation_id, workspace_id, thread_id, session_id
        FROM conversation_bindings
        ORDER BY updated_at ASC
      `)
      .all() as unknown as BindingRow[];
    for (const row of rows) {
      this.memory.bind({
        target: {
          surface: parseSurfaceId(row.surface),
          accountId: row.account_id,
          conversationId: row.conversation_id,
        },
        workspaceId: row.workspace_id,
        threadId: row.thread_id,
        sessionId: row.session_id,
      });
    }
    const actors = this.database
      .prepare(`
        SELECT surface, account_id, conversation_id, actor_id
        FROM conversation_actors
        ORDER BY created_at ASC
      `)
      .all() as unknown as ActorRow[];
    for (const row of actors) {
      this.memory.rememberActor(
        {
          surface: parseSurfaceId(row.surface),
          accountId: row.account_id,
          conversationId: row.conversation_id,
        },
        row.actor_id,
      );
    }
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error("状态数据库已经关闭");
    }
  }
}

function parseSurfaceId(value: string): SurfaceId {
  if (value.length === 0) {
    throw new Error("状态数据库包含空 Surface ID");
  }
  return value;
}

function sameV2Data(current: DatabaseSync, backup: DatabaseSync): boolean {
  const queries = [
    `SELECT surface, conversation_id, workspace_id, updated_at
     FROM conversation_workspaces
     ORDER BY surface, conversation_id`,
    `SELECT surface, conversation_id, workspace_id, thread_id, session_id, updated_at
     FROM conversation_bindings
     ORDER BY surface, conversation_id`,
  ];
  return queries.every((query) => {
    const currentRows = current.prepare(query).all();
    const backupRows = backup.prepare(query).all();
    return JSON.stringify(currentRows) === JSON.stringify(backupRows);
  });
}
