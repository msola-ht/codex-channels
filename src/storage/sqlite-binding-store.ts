import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ConversationTarget } from "../conversation-core/index.js";
import type { BindingStore, ConversationBinding } from "./binding-store.js";
import { MemoryBindingStore } from "./memory-binding-store.js";

interface BindingRow {
  surface: string;
  conversation_id: string;
  workspace_id: string;
  thread_id: string;
  session_id: string;
}

interface WorkspaceRow {
  surface: string;
  conversation_id: string;
  workspace_id: string;
}

const schemaVersion = 2;

export class SqliteBindingStore implements BindingStore {
  private readonly database: DatabaseSync;
  private readonly memory = new MemoryBindingStore();
  private closed = false;

  constructor(readonly path: string) {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);
    this.database = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;");
    this.migrate();
    this.load();
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
        INSERT INTO conversation_workspaces (surface, conversation_id, workspace_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(surface, conversation_id) DO UPDATE SET
          workspace_id = excluded.workspace_id,
          updated_at = excluded.updated_at
      `)
      .run(target.surface, target.conversationId, workspaceId, Date.now());
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
          INSERT INTO conversation_workspaces (surface, conversation_id, workspace_id, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(surface, conversation_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            updated_at = excluded.updated_at
        `)
        .run(
          binding.target.surface,
          binding.target.conversationId,
          binding.workspaceId,
          Date.now(),
        );
      this.database
        .prepare(`
          INSERT INTO conversation_bindings (
            surface, conversation_id, workspace_id, thread_id, session_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(surface, conversation_id) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            thread_id = excluded.thread_id,
            session_id = excluded.session_id,
            updated_at = excluded.updated_at
        `)
        .run(
          binding.target.surface,
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
      .prepare("DELETE FROM conversation_bindings WHERE surface = ? AND conversation_id = ?")
      .run(target.surface, target.conversationId);
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
    if (row.user_version !== 0 && row.user_version !== schemaVersion) {
      throw new Error(
        `状态数据库版本不兼容：当前 ${row.user_version}，Gateway 需要 ${schemaVersion}。开发期间请删除旧状态数据库后重启`,
      );
    }
    if (row.user_version === schemaVersion) {
      return;
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
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
        PRAGMA user_version = 2;
        COMMIT;
      `);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private load(): void {
    const workspaces = this.database
      .prepare(`
        SELECT surface, conversation_id, workspace_id
        FROM conversation_workspaces
        ORDER BY updated_at ASC
      `)
      .all() as unknown as WorkspaceRow[];
    for (const row of workspaces) {
      if (row.surface !== "telegram") {
        throw new Error(`状态数据库包含不支持的 Surface：${row.surface}`);
      }
      this.memory.selectWorkspace(
        { surface: "telegram", conversationId: row.conversation_id },
        row.workspace_id,
      );
    }
    const rows = this.database
      .prepare(`
        SELECT surface, conversation_id, workspace_id, thread_id, session_id
        FROM conversation_bindings
        ORDER BY updated_at ASC
      `)
      .all() as unknown as BindingRow[];
    for (const row of rows) {
      if (row.surface !== "telegram") {
        throw new Error(`状态数据库包含不支持的 Surface：${row.surface}`);
      }
      this.memory.bind({
        target: { surface: "telegram", conversationId: row.conversation_id },
        workspaceId: row.workspace_id,
        threadId: row.thread_id,
        sessionId: row.session_id,
      });
    }
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error("状态数据库已经关闭");
    }
  }
}
