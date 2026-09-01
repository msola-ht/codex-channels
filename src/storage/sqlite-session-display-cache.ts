import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";
import type {
  SessionDisplayCacheEntry,
  SessionDisplayCachePort,
} from "../conversation-core/index.js";

const schemaVersion = 1;

interface CacheRow {
  thread_id: string;
  workspace_id: string;
  archived: number;
  preview: string;
  name: string | null;
  model_provider: string;
  status_type: string;
  active_turn_id: string | null;
  is_pinned: number;
  turn_count: number | null;
  measured_at: number | null;
}

export class SqliteSessionDisplayCache implements SessionDisplayCachePort {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly path: string) {
    const parent = dirname(path);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    securePrivateDirectorySync(parent);
    this.database = new DatabaseSync(path);
    try {
      securePrivateFileSync(path);
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE;");
      this.initializeSchema();
    } catch (error) {
      try {
        this.database.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "会话缓存数据库初始化和清理均失败", {
          cause: closeError,
        });
      }
      throw error;
    }
  }

  get(threadId: string): SessionDisplayCacheEntry | undefined {
    this.requireOpen();
    const row = this.database.prepare(`
      SELECT thread_id, workspace_id, archived, preview, name, model_provider,
        status_type, active_turn_id, is_pinned, turn_count, measured_at
      FROM session_display_cache WHERE thread_id = ?
    `).get(threadId) as CacheRow | undefined;
    return row ? fromRow(row) : undefined;
  }

  put(entry: SessionDisplayCacheEntry): void {
    this.requireOpen();
    this.database.prepare(`
      INSERT INTO session_display_cache (
        thread_id, workspace_id, archived, preview, name, model_provider,
        status_type, active_turn_id, is_pinned, turn_count, measured_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        archived = excluded.archived,
        preview = excluded.preview,
        name = excluded.name,
        model_provider = excluded.model_provider,
        status_type = excluded.status_type,
        active_turn_id = excluded.active_turn_id,
        is_pinned = excluded.is_pinned,
        turn_count = excluded.turn_count,
        measured_at = excluded.measured_at,
        updated_at = excluded.updated_at
    `).run(
      entry.threadId,
      entry.workspaceId,
      entry.archived ? 1 : 0,
      entry.preview,
      entry.name,
      entry.modelProvider,
      entry.status.type,
      entry.activeTurnId,
      entry.isPinned ? 1 : 0,
      entry.turnCount,
      entry.measuredAt,
      Date.now(),
    );
  }

  invalidateTurnCount(threadId: string): void {
    this.requireOpen();
    this.database.prepare(`
      UPDATE session_display_cache SET turn_count = NULL, measured_at = NULL, updated_at = ?
      WHERE thread_id = ?
    `).run(Date.now(), threadId);
  }

  remove(threadId: string): void {
    this.requireOpen();
    this.database.prepare("DELETE FROM session_display_cache WHERE thread_id = ?").run(threadId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private initializeSchema(): void {
    const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === schemaVersion) return;
    if (row.user_version !== 0) {
      throw new Error(`会话缓存数据库版本不兼容：当前 ${row.user_version}，需要 ${schemaVersion}`);
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE session_display_cache (
          thread_id TEXT PRIMARY KEY CHECK (length(thread_id) > 0),
          workspace_id TEXT NOT NULL CHECK (length(workspace_id) > 0),
          archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
          preview TEXT NOT NULL,
          name TEXT,
          model_provider TEXT NOT NULL CHECK (length(model_provider) > 0),
          status_type TEXT NOT NULL CHECK (status_type IN ('notLoaded', 'idle', 'systemError', 'active')),
          active_turn_id TEXT,
          is_pinned INTEGER NOT NULL CHECK (is_pinned IN (0, 1)),
          turn_count INTEGER CHECK (turn_count IS NULL OR turn_count >= 0),
          measured_at INTEGER,
          updated_at INTEGER NOT NULL
        ) STRICT;
        PRAGMA user_version = ${schemaVersion};
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error("会话缓存数据库已关闭");
  }
}

function fromRow(row: CacheRow): SessionDisplayCacheEntry {
  if (!["notLoaded", "idle", "systemError", "active"].includes(row.status_type)) {
    throw new Error("会话缓存包含未知状态");
  }
  return {
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    archived: row.archived === 1,
    preview: row.preview,
    name: row.name,
    modelProvider: row.model_provider,
    status: { type: row.status_type as SessionDisplayCacheEntry["status"]["type"] },
    activeTurnId: row.active_turn_id,
    isPinned: row.is_pinned === 1,
    turnCount: row.turn_count,
    measuredAt: row.measured_at,
  };
}
