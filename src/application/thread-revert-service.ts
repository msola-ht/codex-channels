import { randomUUID } from "node:crypto";

import type { SessionRouter } from "../session-routing/index.js";
import {
  UserFacingError,
  conversationTargetKey,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { ConversationLockCoordinator } from "./conversation-lock-coordinator.js";
import type {
  ThreadHistoryPort,
  ThreadRevertListResult,
  ThreadRevertPreview,
  ThreadTurnSummary,
} from "./thread-history-port.js";
import type { ThreadQueuePage, ThreadQueuePort } from "./thread-queue-port.js";
import {
  maximumNativeQueueItems,
  queueUserFacingError,
} from "./thread-queue-service.js";

const pageSize = 25;
const maximumPages = 20;
const snapshotLifetimeMs = 5 * 60_000;
const maximumSelectionSnapshots = 128;
const maximumConfirmations = 500;

interface RevertPage {
  turns: ThreadTurnSummary[];
  nextCursor: string | null;
  latestTurnId: string | null;
  activeTurnId: string | null;
}

export class ThreadRevertService {
  private readonly selectionSnapshots = new Map<string, {
    threadId: string;
    workspaceId: string;
    page: number;
    turns: ThreadTurnSummary[];
    latestTurnId: string | null;
    activeTurnId: string | null;
    capturedAtMs: number;
  }>();
  private readonly confirmations = new Map<string, {
    targetKey: string;
    actorId: string;
    threadId: string;
    workspaceId: string;
    page: number;
    beforeTurnId: string;
    latestTurnId: string | null;
    activeTurnId: string | null;
    queueFingerprint: string;
    capturedAtMs: number;
  }>();

  constructor(
    private readonly locks: ConversationLockCoordinator,
    private readonly router: SessionRouter,
    private readonly queue?: ThreadQueuePort,
    private readonly history?: ThreadHistoryPort,
  ) {}

  list(
    target: ConversationTarget,
    page = 1,
  ): Promise<ThreadRevertListResult> {
    return this.locks.forConversation(target, async () => {
      if (!Number.isSafeInteger(page) || page < 1 || page > maximumPages) {
        throw new UserFacingError("revert.usage", "Revert 页码无效");
      }
      const binding = this.requireCurrentBinding(target);
      await this.requirePaginatedThread(binding.threadId);
      const result = await this.readPage(binding.threadId, page);
      this.rememberSelectionSnapshot(target, {
        threadId: binding.threadId,
        workspaceId: binding.workspaceId,
        page,
        turns: result.turns,
        latestTurnId: result.latestTurnId,
        activeTurnId: result.activeTurnId,
        capturedAtMs: Date.now(),
      });
      return {
        threadId: binding.threadId,
        turns: result.turns,
        selectors: result.turns.map(
          (_turn, index) => String((page - 1) * pageSize + index + 1),
        ),
        page,
        hasNextPage: result.nextCursor !== null,
      };
    });
  }

  preview(
    target: ConversationTarget,
    selector: string,
    actorId?: string,
  ): Promise<ThreadRevertPreview> {
    return this.locks.forConversation(target, async () => {
      const binding = this.requireCurrentBinding(target);
      await this.requirePaginatedThread(binding.threadId);
      const selection = this.resolveSelection(target, binding.threadId, selector);
      if (selection.workspaceId !== binding.workspaceId) {
        this.invalidate(target);
        throw new UserFacingError(
          "revert.snapshot-required",
          "Workspace 已发生变化，请重新执行 /revert list",
        );
      }
      const currentPage = await this.readPage(binding.threadId, selection.page);
      if (
        !sameTurnIds(currentPage.turns, selection.turns)
        || currentPage.latestTurnId !== selection.latestTurnId
        || currentPage.activeTurnId !== selection.activeTurnId
      ) {
        this.invalidate(target);
        throw new UserFacingError(
          "revert.concurrent",
          "Thread 历史已发生变化，请重新执行 /revert list",
        );
      }
      const turn = currentPage.turns.find(
        (candidate) => candidate.id === selection.beforeTurnId,
      );
      if (!turn) {
        throw new UserFacingError(
          "revert.turn-not-found",
          "找不到指定 Turn，请重新执行 /revert list",
        );
      }
      const queue = await this.readQueue(binding.threadId);
      const token = randomUUID();
      this.rememberConfirmation(token, {
        targetKey: conversationTargetKey(target),
        actorId: actorId ?? target.accountId,
        threadId: binding.threadId,
        workspaceId: binding.workspaceId,
        page: selection.page,
        beforeTurnId: turn.id,
        latestTurnId: currentPage.latestTurnId,
        activeTurnId: currentPage.activeTurnId,
        queueFingerprint: queue.fingerprint,
        capturedAtMs: Date.now(),
      });
      return {
        threadId: binding.threadId,
        beforeTurnId: turn.id,
        turn,
        affectedTurnCount: (selection.page - 1) * pageSize
          + currentPage.turns.indexOf(turn) + 1,
        activeTurnId: currentPage.activeTurnId,
        queueItemCount: queue.count,
        token,
      };
    });
  }

  confirm(
    target: ConversationTarget,
    token: string,
    actorId?: string,
  ): Promise<{ threadId: string; beforeTurnId: string }> {
    return this.locks.forConversation(target, async () => {
      const confirmation = this.confirmations.get(token);
      if (!confirmation) {
        throw confirmationInvalidError();
      }
      // Consume before all checks: a token is single-use even when a
      // concurrent change makes the destructive request fail closed.
      this.confirmations.delete(token);
      if (
        confirmation.targetKey !== conversationTargetKey(target)
        || confirmation.actorId !== (actorId ?? target.accountId)
        || Date.now() - confirmation.capturedAtMs > snapshotLifetimeMs
      ) {
        throw confirmationInvalidError();
      }
      const binding = this.router.current(target);
      if (
        !binding
        || binding.threadId !== confirmation.threadId
        || binding.workspaceId !== confirmation.workspaceId
      ) {
        this.invalidate(target);
        throw new UserFacingError(
          "revert.confirmation-invalid",
          "当前 Thread 或 Workspace 已发生变化，请重新生成 Revert 预览",
        );
      }
      await this.requirePaginatedThread(confirmation.threadId);
      const selection = this.selectionSnapshots.get(conversationTargetKey(target));
      if (
        !selection
        || selection.threadId !== confirmation.threadId
        || selection.page !== confirmation.page
        || Date.now() - selection.capturedAtMs > snapshotLifetimeMs
      ) {
        throw new UserFacingError(
          "revert.confirmation-invalid",
          "Revert 列表已失效，请重新生成预览",
        );
      }
      const currentPage = await this.readPage(confirmation.threadId, confirmation.page);
      const queue = await this.readQueue(confirmation.threadId);
      const currentTurn = currentPage.turns.find(
        (turn) => turn.id === confirmation.beforeTurnId,
      );
      if (
        !sameTurnIds(currentPage.turns, selection.turns)
        || currentPage.latestTurnId !== confirmation.latestTurnId
        || currentPage.activeTurnId !== confirmation.activeTurnId
        || !currentTurn
        || queue.fingerprint !== confirmation.queueFingerprint
      ) {
        this.invalidate(target);
        throw new UserFacingError(
          "revert.concurrent",
          "Thread 历史、活动任务或 Queue 已发生变化，请重新执行 /revert list",
        );
      }
      try {
        await this.requireHistory().revertThread(
          confirmation.threadId,
          confirmation.beforeTurnId,
        );
      } catch (error) {
        throw revertUserFacingError(error);
      }
      this.invalidate(target);
      return {
        threadId: confirmation.threadId,
        beforeTurnId: confirmation.beforeTurnId,
      };
    });
  }

  invalidate(threadId: string): void;
  invalidate(target: ConversationTarget): void;
  invalidate(value: string | ConversationTarget): void;
  invalidate(value: string | ConversationTarget): void {
    if (typeof value !== "string") {
      const targetKey = conversationTargetKey(value);
      this.selectionSnapshots.delete(targetKey);
      for (const [token, confirmation] of this.confirmations) {
        if (confirmation.targetKey === targetKey) this.confirmations.delete(token);
      }
      return;
    }
    for (const [key, snapshot] of this.selectionSnapshots) {
      if (snapshot.threadId === value) this.selectionSnapshots.delete(key);
    }
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.threadId === value) this.confirmations.delete(token);
    }
  }

  private requireCurrentBinding(
    target: ConversationTarget,
  ): { threadId: string; workspaceId: string } {
    const binding = this.router.current(target);
    if (!binding) {
      throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
    }
    return { threadId: binding.threadId, workspaceId: binding.workspaceId };
  }

  private requireHistory(): ThreadHistoryPort {
    if (!this.history) {
      throw new UserFacingError(
        "revert.unavailable",
        "当前 App Server 不支持分页历史回退",
      );
    }
    return this.history;
  }

  private async requirePaginatedThread(threadId: string): Promise<void> {
    const thread = await this.router.readThread(threadId);
    if (thread.historyMode !== "paginated") {
      throw new UserFacingError(
        "revert.legacy-thread",
        "当前 Thread 不支持回退；请新建分页历史会话",
      );
    }
  }

  private async readPage(threadId: string, page: number): Promise<RevertPage> {
    const history = this.requireHistory();
    let cursor: string | null = null;
    let latestTurnId: string | null = null;
    let activeTurnId: string | null = null;
    const seenCursors = new Set<string>();
    const seenTurnIds = new Set<string>();
    for (let currentPage = 1; currentPage <= page; currentPage += 1) {
      if (cursor !== null) {
        if (seenCursors.has(cursor)) {
          throw new UserFacingError(
            "revert.unavailable",
            "Codex Turn 列表返回了循环分页游标",
          );
        }
        seenCursors.add(cursor);
      }
      let result: Awaited<ReturnType<ThreadHistoryPort["listThreadTurns"]>>;
      try {
        result = await history.listThreadTurns(threadId, {
          cursor,
          limit: pageSize,
          sortDirection: "desc",
        });
      } catch (error) {
        throw revertListUserFacingError(error);
      }
      for (const turn of result.turns) {
        if (seenTurnIds.has(turn.id)) {
          throw new UserFacingError(
            "revert.unavailable",
            "Codex Turn 分页包含重复 Turn",
          );
        }
        seenTurnIds.add(turn.id);
      }
      if (currentPage === 1) {
        latestTurnId = result.turns[0]?.id ?? null;
        const activeTurns = result.turns.filter((turn) => turn.status === "inProgress");
        if (activeTurns.length > 1) {
          throw new UserFacingError(
            "revert.unavailable",
            "Codex Turn 列表包含多个活动 Turn",
          );
        }
        activeTurnId = activeTurns[0]?.id ?? null;
      }
      if (currentPage === page) {
        if (result.nextCursor !== null && !result.nextCursor.trim()) {
          throw new UserFacingError(
            "revert.unavailable",
            "Codex Turn 列表返回了无效分页游标",
          );
        }
        if (result.nextCursor !== null && seenCursors.has(result.nextCursor)) {
          throw new UserFacingError(
            "revert.unavailable",
            "Codex Turn 列表返回了循环分页游标",
          );
        }
        return {
          turns: result.turns,
          nextCursor: result.nextCursor,
          latestTurnId,
          activeTurnId,
        };
      }
      if (result.nextCursor === null) {
        return { turns: [], nextCursor: null, latestTurnId, activeTurnId };
      }
      if (!result.nextCursor.trim() || seenCursors.has(result.nextCursor)) {
        throw new UserFacingError(
          "revert.unavailable",
          "Codex Turn 列表返回了循环分页游标",
        );
      }
      cursor = result.nextCursor;
    }
    throw new UserFacingError("revert.unavailable", "Codex Turn 列表页码超出安全范围");
  }

  private resolveSelection(
    target: ConversationTarget,
    threadId: string,
    selector: string,
  ): {
    page: number;
    beforeTurnId: string;
    workspaceId: string;
    turns: ThreadTurnSummary[];
    latestTurnId: string | null;
    activeTurnId: string | null;
  } {
    const snapshot = this.selectionSnapshots.get(conversationTargetKey(target));
    if (
      !snapshot
      || snapshot.threadId !== threadId
      || Date.now() - snapshot.capturedAtMs > snapshotLifetimeMs
    ) {
      throw new UserFacingError(
        "revert.snapshot-required",
        "Turn 选择器只对最近五分钟的 /revert list 页面有效，请先执行 /revert list",
      );
    }
    const normalized = selector.trim();
    const index = /^\d+$/u.test(normalized)
      ? Number(normalized) - 1 - (snapshot.page - 1) * pageSize
      : snapshot.turns.findIndex((turn) => turn.id === normalized);
    const turn = Number.isSafeInteger(index) && index >= 0
      ? snapshot.turns[index]
      : undefined;
    if (!turn) {
      throw new UserFacingError(
        "revert.turn-not-found",
        "找不到指定 Turn；完整 ID 也必须来自最近一次 /revert list 页面",
      );
    }
    return {
      page: snapshot.page,
      beforeTurnId: turn.id,
      workspaceId: snapshot.workspaceId,
      turns: snapshot.turns,
      latestTurnId: snapshot.latestTurnId,
      activeTurnId: snapshot.activeTurnId,
    };
  }

  private async readQueue(
    threadId: string,
  ): Promise<{ count: number; fingerprint: string }> {
    if (!this.queue) {
      throw new UserFacingError(
        "revert.queue-unknown",
        "无法确认当前 Queue，Revert 已失败关闭",
      );
    }
    let page: ThreadQueuePage;
    try {
      page = await this.queue.listQueue(threadId, { limit: maximumNativeQueueItems });
    } catch (error) {
      throw queueUserFacingError(error, "list");
    }
    if (
      page.nextCursor !== null
      || page.items.length > maximumNativeQueueItems
      || typeof page.fingerprint !== "string"
      || page.fingerprint.length !== 64
    ) {
      throw new UserFacingError(
        "revert.queue-unknown",
        "无法确认当前 Queue，Revert 已失败关闭",
      );
    }
    return { count: page.items.length, fingerprint: page.fingerprint };
  }

  private rememberSelectionSnapshot(
    target: ConversationTarget,
    snapshot: {
      threadId: string;
      workspaceId: string;
      page: number;
      turns: ThreadTurnSummary[];
      latestTurnId: string | null;
      activeTurnId: string | null;
      capturedAtMs: number;
    },
  ): void {
    const now = Date.now();
    for (const [key, value] of this.selectionSnapshots) {
      if (now - value.capturedAtMs > snapshotLifetimeMs) {
        this.selectionSnapshots.delete(key);
      }
    }
    const key = conversationTargetKey(target);
    for (const [token, confirmation] of this.confirmations) {
      if (confirmation.targetKey === key) this.confirmations.delete(token);
    }
    this.selectionSnapshots.delete(key);
    this.selectionSnapshots.set(key, snapshot);
    while (this.selectionSnapshots.size > maximumSelectionSnapshots) {
      const oldest = this.selectionSnapshots.keys().next().value;
      if (oldest === undefined) break;
      this.selectionSnapshots.delete(oldest);
    }
  }

  private rememberConfirmation(
    token: string,
    confirmation: {
      targetKey: string;
      actorId: string;
      threadId: string;
      workspaceId: string;
      page: number;
      beforeTurnId: string;
      latestTurnId: string | null;
      activeTurnId: string | null;
      queueFingerprint: string;
      capturedAtMs: number;
    },
  ): void {
    const now = Date.now();
    for (const [currentToken, value] of this.confirmations) {
      if (now - value.capturedAtMs > snapshotLifetimeMs) {
        this.confirmations.delete(currentToken);
      }
    }
    this.confirmations.set(token, confirmation);
    while (this.confirmations.size > maximumConfirmations) {
      const oldest = this.confirmations.keys().next().value;
      if (oldest === undefined) break;
      this.confirmations.delete(oldest);
    }
  }
}

function sameTurnIds(
  left: readonly ThreadTurnSummary[],
  right: readonly ThreadTurnSummary[],
): boolean {
  return left.length === right.length
    && left.every((turn, index) => turn.id === right[index]?.id);
}

function confirmationInvalidError(): UserFacingError {
  return new UserFacingError(
    "revert.confirmation-invalid",
    "Revert 确认已失效，请重新生成预览",
  );
}

function revertUserFacingError(error: unknown): UserFacingError {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("turn not found")) {
    return new UserFacingError("revert.turn-not-found", "指定 Turn 不存在，Revert 未执行");
  }
  if (message.includes("legacy") || message.includes("paginated")) {
    return new UserFacingError(
      "revert.legacy-thread",
      "当前 Thread 不支持回退；请新建分页历史会话",
    );
  }
  return new UserFacingError(
    "revert.result-unknown",
    "Revert 结果未知；请求不会自动重试，请重新执行 /revert list 核对历史",
  );
}

function revertListUserFacingError(error: unknown): UserFacingError {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("before first user message") || message.includes("not materialized")) {
    return new UserFacingError("revert.empty-history", "当前 Thread 还没有可回退的 Turn");
  }
  if (message.includes("paginated")) {
    return new UserFacingError(
      "revert.legacy-thread",
      "当前 Thread 不支持回退；请新建分页历史会话",
    );
  }
  return new UserFacingError("revert.unavailable", "当前 App Server 无法读取分页历史");
}
