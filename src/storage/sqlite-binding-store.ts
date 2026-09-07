import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../../runtime/private-file.mjs";

import {
  conversationTargetKey,
  type ConversationTarget,
  type SurfaceId,
} from "../conversation-core/index.js";
import type {
  BindingStore,
  BindingSwitch,
  BindingTransfer,
  ConversationBinding,
  ConversationIdleState,
} from "./binding-store.js";
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

interface IdleStateRow {
  surface: string;
  account_id: string;
  conversation_id: string;
  last_activity_at: number;
  force_new: number;
}

const schemaVersion = 5;
const idleStatePersistenceIntervalMs = 60_000;

export class SqliteBindingStore implements BindingStore {
  private readonly database: DatabaseSync;
  private readonly memory = new MemoryBindingStore();
  private readonly lastPersistedActivity = new Map<string, number>();
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

  conversations(): ConversationTarget[] {
    return this.memory.conversations();
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
    const removeBindings = knownActorIds.every((actorId) => !actorIds.has(actorId));
    const bindingRemoved = removeBindings && (
      this.memory.get(target) !== undefined || this.memory.backgrounds(target).length > 0
    );
    let forceNewAtMs = 0;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removeActor = this.database.prepare(`
        DELETE FROM conversation_actors
        WHERE surface = ? AND account_id = ? AND conversation_id = ? AND actor_id = ?
      `);
      for (const actorId of removedActorIds) {
        removeActor.run(target.surface, target.accountId, target.conversationId, actorId);
      }
      if (removeBindings) {
        forceNewAtMs = Math.max(
          this.memory.idleState(target).lastActivityAt,
          Date.now(),
        );
        this.database
          .prepare(`
            DELETE FROM conversation_bindings
            WHERE surface = ? AND account_id = ? AND conversation_id = ?
          `)
          .run(target.surface, target.accountId, target.conversationId);
        this.database
          .prepare(`
            DELETE FROM conversation_background_bindings
            WHERE surface = ? AND account_id = ? AND conversation_id = ?
          `)
          .run(target.surface, target.accountId, target.conversationId);
        this.database
          .prepare(`
            INSERT INTO conversation_idle_state (
              surface, account_id, conversation_id, last_activity_at, force_new
            ) VALUES (?, ?, ?, ?, 1)
            ON CONFLICT(surface, account_id, conversation_id) DO UPDATE SET
              last_activity_at = excluded.last_activity_at,
              force_new = 1
          `)
          .run(
            target.surface,
            target.accountId,
            target.conversationId,
            forceNewAtMs,
          );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    for (const actorId of removedActorIds) {
      this.memory.forgetActor(target, actorId);
    }
    if (removeBindings) {
      this.memory.unbind(target);
      for (const binding of this.memory.backgrounds(target)) {
        this.memory.removeThread(binding.threadId);
      }
      this.memory.setForceNew(target, forceNewAtMs, true);
      this.lastPersistedActivity.set(
        conversationTargetKey(target),
        forceNewAtMs,
      );
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

  backgrounds(target: ConversationTarget): ConversationBinding[] {
    return this.memory.backgrounds(target);
  }

  isBackground(threadId: string): boolean {
    return this.memory.isBackground(threadId);
  }

  getByThread(threadId: string): ConversationBinding | undefined {
    return this.memory.getByThread(threadId);
  }

  list(): ConversationBinding[] {
    return this.memory.list();
  }

  idleState(target: ConversationTarget): ConversationIdleState {
    return this.memory.idleState(target);
  }

  ensureIdleState(target: ConversationTarget, atMs: number): void {
    this.requireOpen();
    if (this.memory.idleState(target).lastActivityAt !== 0) {
      return;
    }
    this.database
      .prepare(`
        INSERT OR IGNORE INTO conversation_idle_state (
          surface, account_id, conversation_id, last_activity_at, force_new
        ) VALUES (?, ?, ?, ?, 0)
      `)
      .run(target.surface, target.accountId, target.conversationId, atMs);
    this.memory.ensureIdleState(target, atMs);
    this.lastPersistedActivity.set(
      conversationTargetKey(target),
      atMs,
    );
  }

  touchActivity(target: ConversationTarget, atMs: number): void {
    this.requireOpen();
    const current = this.memory.idleState(target);
    const key = conversationTargetKey(target);
    const lastPersisted = this.lastPersistedActivity.get(key) ?? 0;
    const effectiveAtMs = Math.max(current.lastActivityAt, atMs);
    const shouldPersist = current.lastActivityAt === 0
      || atMs - lastPersisted >= idleStatePersistenceIntervalMs;
    if (shouldPersist) {
      this.database
        .prepare(`
          INSERT INTO conversation_idle_state (
            surface, account_id, conversation_id, last_activity_at, force_new
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(surface, account_id, conversation_id) DO UPDATE SET
            last_activity_at = excluded.last_activity_at
        `)
        .run(
          target.surface,
          target.accountId,
          target.conversationId,
          effectiveAtMs,
          current.forceNew ? 1 : 0,
        );
      this.lastPersistedActivity.set(key, effectiveAtMs);
    }
    this.memory.touchActivity(target, effectiveAtMs);
  }

  setForceNew(target: ConversationTarget, atMs: number, forceNew: boolean): void {
    this.requireOpen();
    const current = this.memory.idleState(target);
    const effectiveAtMs = Math.max(current.lastActivityAt, atMs);
    this.upsertIdleState(target, effectiveAtMs, forceNew);
    this.memory.setForceNew(target, effectiveAtMs, forceNew);
    this.lastPersistedActivity.set(conversationTargetKey(target), effectiveAtMs);
  }

  bind(binding: ConversationBinding): void {
    this.switchForeground(binding, false);
  }

  bindBackground(binding: ConversationBinding): void {
    this.requireOpen();
    const owner = this.memory.getByThread(binding.threadId);
    if (owner && !sameTarget(owner.target, binding.target)) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM conversation_bindings WHERE thread_id = ?")
        .run(binding.threadId);
      insertBackground(this.database, binding);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.memory.bindBackground(binding);
  }

  switchForeground(
    binding: ConversationBinding,
    preserveCurrent: boolean,
  ): BindingSwitch {
    this.requireOpen();
    const owner = this.memory.getByThread(binding.threadId);
    if (owner && !sameTarget(owner.target, binding.target)) {
      throw new Error("该 Codex Thread 已绑定到其他会话");
    }
    const previous = this.memory.get(binding.target);
    try {
      this.database.exec("BEGIN IMMEDIATE");
      this.database
        .prepare("DELETE FROM conversation_background_bindings WHERE thread_id = ?")
        .run(binding.threadId);
      if (previous && previous.threadId !== binding.threadId) {
        if (preserveCurrent) {
          insertBackground(this.database, previous);
        } else {
          this.database
            .prepare("DELETE FROM conversation_background_bindings WHERE thread_id = ?")
            .run(previous.threadId);
        }
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
      throw error;
    }
    const result = this.memory.switchForeground(binding, preserveCurrent);
    return result;
  }

  demote(target: ConversationTarget): ConversationBinding | undefined {
    this.requireOpen();
    const current = this.memory.get(target);
    if (!current) return undefined;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      insertBackground(this.database, current);
      this.database.prepare(`
        DELETE FROM conversation_bindings
        WHERE surface = ? AND account_id = ? AND conversation_id = ?
      `).run(target.surface, target.accountId, target.conversationId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.memory.demote(target);
  }

  removeThread(threadId: string): ConversationBinding | undefined {
    this.requireOpen();
    const binding = this.memory.getByThread(threadId);
    if (!binding) return undefined;
    const foreground = this.memory.isBackground(threadId) !== true;
    const atMs = Math.max(
      this.memory.idleState(binding.target).lastActivityAt,
      Date.now(),
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare("DELETE FROM conversation_background_bindings WHERE thread_id = ?")
        .run(threadId);
      this.database.prepare("DELETE FROM conversation_bindings WHERE thread_id = ?")
        .run(threadId);
      if (foreground) {
        this.upsertIdleState(binding.target, atMs, true);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const removed = this.memory.removeThread(threadId);
    if (foreground) {
      this.memory.setForceNew(binding.target, atMs, true);
      this.lastPersistedActivity.set(conversationTargetKey(binding.target), atMs);
    }
    return removed;
  }

  transfer(threadId: string, target: ConversationTarget): BindingTransfer {
    this.requireOpen();
    const previousOwner = this.memory.getByThread(threadId);
    if (!previousOwner) {
      throw new Error("待转移的 Codex Thread 当前没有外部会话绑定");
    }
    if (this.memory.isBackground(threadId)) {
      throw new Error("运行中的后台 Thread 不能跨渠道接管");
    }
    if (sameTarget(previousOwner.target, target)) {
      return { binding: previousOwner, previousOwner };
    }
    const replaced = this.memory.get(target);
    const binding = {
      target,
      workspaceId: previousOwner.workspaceId,
      threadId: previousOwner.threadId,
      sessionId: previousOwner.sessionId,
    };
    const previousAtMs = Math.max(
      this.memory.idleState(previousOwner.target).lastActivityAt,
      Date.now(),
    );
    const targetAtMs = Math.max(
      this.memory.idleState(target).lastActivityAt,
      Date.now(),
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const removeBinding = this.database.prepare(`
        DELETE FROM conversation_bindings
        WHERE surface = ? AND account_id = ? AND conversation_id = ?
      `);
      if (replaced) {
        removeBinding.run(
          replaced.target.surface,
          replaced.target.accountId,
          replaced.target.conversationId,
        );
      }
      removeBinding.run(
        previousOwner.target.surface,
        previousOwner.target.accountId,
        previousOwner.target.conversationId,
      );
      this.upsertIdleState(previousOwner.target, previousAtMs, true);
      this.upsertIdleState(target, targetAtMs, false);
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
          target.surface,
          target.accountId,
          target.conversationId,
          binding.workspaceId,
          Date.now(),
        );
      this.database
        .prepare(`
          INSERT INTO conversation_bindings (
            surface, account_id, conversation_id, workspace_id, thread_id, session_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          target.surface,
          target.accountId,
          target.conversationId,
          binding.workspaceId,
          binding.threadId,
          binding.sessionId,
          Date.now(),
        );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const transfer = this.memory.transfer(threadId, target);
    this.memory.setForceNew(previousOwner.target, previousAtMs, true);
    this.memory.setForceNew(target, targetAtMs, false);
    this.lastPersistedActivity.set(conversationTargetKey(previousOwner.target), previousAtMs);
    this.lastPersistedActivity.set(conversationTargetKey(target), targetAtMs);
    return transfer;
  }

  unbind(target: ConversationTarget): ConversationBinding | undefined {
    this.requireOpen();
    const binding = this.memory.get(target);
    if (!binding) {
      return undefined;
    }
    const atMs = Math.max(
      this.memory.idleState(target).lastActivityAt,
      Date.now(),
    );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(`
          DELETE FROM conversation_bindings
          WHERE surface = ? AND account_id = ? AND conversation_id = ?
        `)
        .run(target.surface, target.accountId, target.conversationId);
      this.upsertIdleState(target, atMs, true);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const removed = this.memory.unbind(target);
    this.memory.setForceNew(target, atMs, true);
    this.lastPersistedActivity.set(conversationTargetKey(target), atMs);
    return removed;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.database.close();
    this.memory.close();
  }

  private initializeSchema(): void {
    const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version === schemaVersion) {
      return;
    }
    if (row.user_version !== 0) {
      throw new Error(
        `状态数据库版本不兼容：当前 ${row.user_version}，Gateway 需要 ${schemaVersion}。请运行 codexc update`,
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

      CREATE TABLE conversation_background_bindings (
        surface TEXT NOT NULL CHECK (length(surface) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        conversation_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        thread_id TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE conversation_idle_state (
        surface TEXT NOT NULL CHECK (length(surface) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        conversation_id TEXT NOT NULL,
        last_activity_at INTEGER NOT NULL,
        force_new INTEGER NOT NULL CHECK (force_new IN (0, 1)),
        PRIMARY KEY (surface, account_id, conversation_id)
      ) STRICT;
    `);
    this.createActorSchema();
  }

  private createActorSchema(): void {
    this.database.exec(`
      CREATE TABLE conversation_actors (
        surface TEXT NOT NULL CHECK (length(surface) > 0),
        account_id TEXT NOT NULL CHECK (length(account_id) > 0),
        conversation_id TEXT NOT NULL,
        actor_id TEXT NOT NULL CHECK (length(actor_id) > 0),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (surface, account_id, conversation_id, actor_id)
      ) STRICT;
    `);
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
    const backgroundRows = this.database
      .prepare(`
        SELECT surface, account_id, conversation_id, workspace_id, thread_id, session_id
        FROM conversation_background_bindings
        ORDER BY updated_at ASC
      `)
      .all() as unknown as BindingRow[];
    for (const row of backgroundRows) {
      const binding = bindingFromRow(row);
      const foreground = this.memory.get(binding.target);
      if (foreground) {
        this.memory.switchForeground(binding, true);
        this.memory.switchForeground(foreground, true);
      } else {
        this.memory.bind(binding);
        this.memory.demote(binding.target);
      }
    }
    const idleStateRows = this.database
      .prepare(`
        SELECT surface, account_id, conversation_id, last_activity_at, force_new
        FROM conversation_idle_state
      `)
      .all() as unknown as IdleStateRow[];
    for (const row of idleStateRows) {
      const target = {
        surface: parseSurfaceId(row.surface),
        accountId: row.account_id,
        conversationId: row.conversation_id,
      };
      this.memory.ensureIdleState(target, row.last_activity_at);
      this.memory.setForceNew(
        target,
        row.last_activity_at,
        row.force_new === 1,
      );
      this.lastPersistedActivity.set(
        conversationTargetKey(target),
        row.last_activity_at,
      );
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

  private upsertIdleState(
    target: ConversationTarget,
    atMs: number,
    forceNew: boolean,
  ): void {
    this.database
      .prepare(`
        INSERT INTO conversation_idle_state (
          surface, account_id, conversation_id, last_activity_at, force_new
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(surface, account_id, conversation_id) DO UPDATE SET
          last_activity_at = excluded.last_activity_at,
          force_new = excluded.force_new
      `)
      .run(
        target.surface,
        target.accountId,
        target.conversationId,
        atMs,
        forceNew ? 1 : 0,
      );
  }

  private requireOpen(): void {
    if (this.closed) {
      throw new Error("状态数据库已经关闭");
    }
  }
}

function sameTarget(
  left: ConversationTarget,
  right: ConversationTarget,
): boolean {
  return left.surface === right.surface
    && left.accountId === right.accountId
    && left.conversationId === right.conversationId;
}

function parseSurfaceId(value: string): SurfaceId {
  if (value.length === 0) {
    throw new Error("状态数据库包含空 Surface ID");
  }
  return value;
}

function bindingFromRow(row: BindingRow): ConversationBinding {
  return {
    target: {
      surface: parseSurfaceId(row.surface),
      accountId: row.account_id,
      conversationId: row.conversation_id,
    },
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    sessionId: row.session_id,
  };
}

function insertBackground(database: DatabaseSync, binding: ConversationBinding): void {
  database.prepare(`
    INSERT INTO conversation_background_bindings (
      surface, account_id, conversation_id, workspace_id, thread_id, session_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      surface = excluded.surface,
      account_id = excluded.account_id,
      conversation_id = excluded.conversation_id,
      workspace_id = excluded.workspace_id,
      session_id = excluded.session_id,
      updated_at = excluded.updated_at
  `).run(
    binding.target.surface,
    binding.target.accountId,
    binding.target.conversationId,
    binding.workspaceId,
    binding.threadId,
    binding.sessionId,
    Date.now(),
  );
}
