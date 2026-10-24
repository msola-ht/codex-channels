import { randomUUID } from "node:crypto";
import { trimOldestEntries } from "./bounded-map.js";

import type { SessionRouter } from "../session-routing/index.js";
import {
  UserFacingError,
  conversationTargetKey,
  gatewayUserMessageClientIdPrefix,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { CollaborationModeSelectionService } from "./collaboration-mode-service.js";
import type { ConversationLockCoordinator } from "./conversation-lock-coordinator.js";
import type { ModelSelectionService } from "./model-selection-service.js";
import { ThreadQueueError } from "./thread-queue-port.js";
import type {
  ThreadQueueItem,
  ThreadQueuePage,
  ThreadQueuePort,
  ThreadQueueSubmissionOrigin,
} from "./thread-queue-port.js";
import { pageCountFor, pageSelector, pageSlice, requirePage } from "./pagination.js";

export const maximumNativeQueueItems = 100;
const nativeQueuePageSize = 25;
const maximumNativeQueuePages = 4;
const selectionSnapshotLifetimeMs = 5 * 60_000;
const maximumSelectionSnapshots = 128;

export interface ThreadQueueListResult {
  items: ThreadQueueItem[];
  selectors: string[];
  page: number;
  pageCount: number;
  totalItemCount: number;
}

export interface ThreadQueueReorderResult {
  itemId: string;
  position: number;
  totalItemCount: number;
}

export class ThreadQueueService {
  private readonly pendingLists = new Set<{ threadId: string; targetKey: string; invalidated: boolean }>();
  private readonly selectionSnapshots = new Map<string, {
    threadId: string;
    itemIds: string[];
    capturedAtMs: number;
  }>();

  constructor(
    private readonly locks: ConversationLockCoordinator,
    private readonly router: SessionRouter,
    private readonly models: ModelSelectionService,
    private readonly collaborationModes?: CollaborationModeSelectionService,
    private readonly queue?: ThreadQueuePort,
  ) {}

  async add(
    target: ConversationTarget,
    value: string,
    assertAuthorized?: () => void,
    captureOrigin?: (origin: ThreadQueueSubmissionOrigin) => void,
  ): Promise<ThreadQueueItem> {
    assertAuthorized?.();
    const threadId = this.requireCurrentThread(target);
    return this.locks.forConversation(target, async () => {
      const beforeSubmit = await this.threadGuard(target, threadId, assertAuthorized);
      beforeSubmit();
      const queue = this.requireQueue();
      this.rejectPendingOverrides(target);
      const text = normalizeQueueText(value);
      beforeSubmit();
      const clientId = `${gatewayUserMessageClientIdPrefix}${randomUUID()}`;
      captureOrigin?.({ threadId, clientId });
      try {
        const item = await queue.addQueueItem(
          threadId,
          text,
          clientId,
          beforeSubmit,
        );
        this.invalidateSnapshot(threadId);
        return item;
      } catch (error) {
        throw queueUserFacingError(error, "add");
      }
    });
  }

  async list(
    target: ConversationTarget,
    page = 1,
    assertAuthorized?: () => void,
  ): Promise<ThreadQueueListResult> {
    assertAuthorized?.();
    const threadId = this.requireCurrentThread(target);
    return this.locks.forConversation(target, async () => {
      const beforeSubmit = await this.threadGuard(target, threadId, assertAuthorized);
      beforeSubmit();
      requirePage(page, maximumNativeQueuePages, () => {
        throw new UserFacingError("queue.usage", "Queue 页码无效");
      });
      const pending = { threadId, targetKey: conversationTargetKey(target), invalidated: false };
      this.pendingLists.add(pending);
      try {
        const snapshot = await this.readSnapshot(threadId, beforeSubmit);
        beforeSubmit();
        if (pending.invalidated) {
          throw new UserFacingError("queue.snapshot.required", "Queue 列表读取期间已变化，请重新执行 /queue list");
        }
        const pageCount = pageCountFor(snapshot.items.length, nativeQueuePageSize);
        const items = pageSlice(snapshot.items, page, nativeQueuePageSize, pageCount);
        this.rememberSelectionSnapshot(target, threadId, snapshot.items.map((item) => item.id));
        return {
          items,
          selectors: items.map((_item, index) => pageSelector(page, index, nativeQueuePageSize)),
          page,
          pageCount,
          totalItemCount: snapshot.items.length,
        };
      } finally {
        this.pendingLists.delete(pending);
      }
    });
  }

  async update(
    target: ConversationTarget,
    selector: string,
    value: string,
    assertAuthorized?: () => void,
  ): Promise<ThreadQueueItem> {
    assertAuthorized?.();
    const threadId = this.requireCurrentThread(target);
    return this.locks.forConversation(target, async () => {
      const beforeSubmit = await this.threadGuard(target, threadId, assertAuthorized);
      beforeSubmit();
      const queue = this.requireQueue();
      const item = await this.resolveSelector(target, threadId, selector, beforeSubmit);
      beforeSubmit();
      if (!item.editable) {
        throw new UserFacingError(
          "queue.item-not-editable",
          "该 Queue 条目不是纯文本，不能更新",
        );
      }
      const text = normalizeQueueText(value);
      try {
        const updated = await queue.updateQueueItem(threadId, item.id, text, beforeSubmit);
        this.invalidateSnapshot(threadId);
        return updated;
      } catch (error) {
        throw queueUserFacingError(error, "update");
      }
    });
  }

  async delete(
    target: ConversationTarget,
    selector: string,
    assertAuthorized?: () => void,
  ): Promise<{ deleted: boolean }> {
    assertAuthorized?.();
    const threadId = this.requireCurrentThread(target);
    return this.locks.forConversation(target, async () => {
      const beforeSubmit = await this.threadGuard(target, threadId, assertAuthorized);
      beforeSubmit();
      const queue = this.requireQueue();
      const item = await this.resolveSelector(target, threadId, selector, beforeSubmit);
      beforeSubmit();
      try {
        const result = await queue.deleteQueueItem(threadId, item.id, beforeSubmit);
        this.invalidateSnapshot(threadId);
        return result;
      } catch (error) {
        throw queueUserFacingError(error, "delete");
      }
    });
  }

  async reorder(
    target: ConversationTarget,
    selector: string,
    position: number,
    assertAuthorized?: () => void,
  ): Promise<ThreadQueueReorderResult> {
    assertAuthorized?.();
    const threadId = this.requireCurrentThread(target);
    return this.locks.forConversation(target, async () => {
      const beforeSubmit = await this.threadGuard(target, threadId, assertAuthorized);
      beforeSubmit();
      const queue = this.requireQueue();
      const resolved = await this.resolveSelectorSnapshot(target, threadId, selector, beforeSubmit);
      beforeSubmit();
      const { snapshot, item } = resolved;
      if (!Number.isSafeInteger(position) || position < 1 || position > snapshot.items.length) {
        throw new UserFacingError("queue.position.invalid", "Queue 目标位置超出当前队列范围");
      }
      const ids = snapshot.items.map((entry) => entry.id).filter((id) => id !== item.id);
      ids.splice(position - 1, 0, item.id);
      try {
        await queue.reorderQueue(threadId, ids, beforeSubmit);
        this.invalidateSnapshot(threadId);
        return { itemId: item.id, position, totalItemCount: snapshot.items.length };
      } catch (error) {
        this.invalidateSnapshot(threadId);
        throw queueUserFacingError(error, "reorder");
      }
    });
  }

  async start(
    target: ConversationTarget,
    selector?: string,
    assertAuthorized?: () => void,
  ): Promise<{ turnId: string }> {
    assertAuthorized?.();
    const threadId = this.requireCurrentThread(target);
    return this.locks.forConversation(target, async () => {
      const beforeSubmit = await this.threadGuard(target, threadId, assertAuthorized);
      beforeSubmit();
      const queue = this.requireQueue();
      this.rejectPendingOverrides(target);
      let queuedSubmissionId: string | undefined;
      if (selector?.trim()) {
        queuedSubmissionId = (
          await this.resolveSelectorSnapshot(target, threadId, selector, beforeSubmit)
        ).item.id;
      }
      beforeSubmit();
      try {
        const result = await queue.startQueueItem(threadId, queuedSubmissionId, beforeSubmit);
        this.invalidateSnapshot(threadId);
        return result;
      } catch (error) {
        throw queueUserFacingError(error, "start");
      }
    });
  }

  invalidateSnapshot(threadId: string): void {
    for (const pending of this.pendingLists) {
      if (pending.threadId === threadId) pending.invalidated = true;
    }
    for (const [key, snapshot] of this.selectionSnapshots) {
      if (snapshot.threadId === threadId) {
        this.selectionSnapshots.delete(key);
      }
    }
  }

  clearSnapshot(target: ConversationTarget): void {
    const key = conversationTargetKey(target);
    this.selectionSnapshots.delete(key);
    for (const pending of this.pendingLists) {
      if (pending.targetKey === key) pending.invalidated = true;
    }
  }

  async rejectPendingOverrideChange(target: ConversationTarget, assertAuthorized?: () => void): Promise<void> {
    assertAuthorized?.();
    const threadId = this.router.current?.(target)?.threadId;
    if (!threadId || !this.queue) return;
    if (await this.hasItems(threadId, assertAuthorized)) {
      throw new UserFacingError(
        "queue.pending-overrides",
        "Queue 与待生效的模型、思考、速度或 Plan 选择不能同时存在；请先让其中一方处理完成",
      );
    }
  }

  async hasItems(threadId: string, assertAuthorized?: () => void): Promise<boolean> {
    assertAuthorized?.();
    if (!this.queue) return false;
    try {
      const page = await this.queue.listQueue(threadId, { limit: 1, ...(assertAuthorized ? { beforeSubmit: assertAuthorized } : {}) });
      assertAuthorized?.();
      return page.items.length > 0 || page.nextCursor !== null;
    } catch (error) {
      assertAuthorized?.();
      const mapped = queueUserFacingError(error, "list");
      if (mapped.code === "queue.unavailable") return false;
      throw mapped;
    }
  }

  private requireCurrentThread(target: ConversationTarget): string {
    const binding = this.router.current(target);
    if (!binding) {
      throw new UserFacingError("conversation.missing", "当前还没有 Codex Session");
    }
    return binding.threadId;
  }

  private async threadGuard(
    target: ConversationTarget,
    threadId: string,
    assertAuthorized?: () => void,
  ): Promise<() => void> {
    return this.router.prepareThreadWorkspaceGuard(threadId, () => {
      assertAuthorized?.();
      if (this.router.current(target)?.threadId !== threadId) {
        throw new UserFacingError(
          "command.authorization-changed",
          "当前会话已切换，请重新执行 Queue 命令",
        );
      }
    });
  }

  private requireQueue(): ThreadQueuePort {
    if (!this.queue) {
      throw new UserFacingError(
        "queue.unavailable",
        "当前 App Server 不提供持久队列",
      );
    }
    return this.queue;
  }

  private rejectPendingOverrides(target: ConversationTarget): void {
    if (this.models.hasPending?.(target) || this.collaborationModes?.hasPending?.(target)) {
      throw new UserFacingError(
        "queue.pending-overrides",
        "Queue 与待生效的模型、思考、Fast 或 Plan 选择不能同时存在；请先让其中一方处理完成",
      );
    }
  }

  private async readSnapshot(
    threadId: string,
    beforeSubmit: () => void,
  ): Promise<{ items: ThreadQueueItem[] }> {
    beforeSubmit();
    const queue = this.requireQueue();
    let response: ThreadQueuePage;
    try {
      response = await queue.listQueue(threadId, { limit: maximumNativeQueueItems, beforeSubmit });
    } catch (error) {
      throw queueUserFacingError(error, "list");
    }
    beforeSubmit();
    if (response.items.length > maximumNativeQueueItems || response.nextCursor !== null) {
      throw new UserFacingError(
        "queue.unavailable",
        "当前 App Server 返回了不完整或超过 100 条的 Queue 页面",
      );
    }
    const items = response.items;
    return { items };
  }

  private async resolveSelectorSnapshot(
    target: ConversationTarget,
    threadId: string,
    selector: string,
    beforeSubmit: () => void,
  ): Promise<{ snapshot: { items: ThreadQueueItem[] }; item: ThreadQueueItem }> {
    beforeSubmit();
    const normalized = selector.trim();
    let selectedId = normalized;
    const numeric = /^\d+$/u.test(normalized);
    const selection = numeric ? this.selectionSnapshots.get(conversationTargetKey(target)) : undefined;
    if (numeric) {
      if (
        !selection
        || selection.threadId !== threadId
        || Date.now() - selection.capturedAtMs > selectionSnapshotLifetimeMs
      ) {
        throw new UserFacingError(
          "queue.snapshot.required",
          "数字选择器只对最近五分钟的 Queue 列表有效，请先执行 /queue list",
        );
      }
      const index = Number(normalized) - 1;
      selectedId = Number.isSafeInteger(index) && index >= 0
        ? selection.itemIds[index] ?? ""
        : "";
    }
    const snapshot = await this.readSnapshot(threadId, beforeSubmit);
    beforeSubmit();
    if (selection && (this.selectionSnapshots.get(conversationTargetKey(target)) !== selection
      || Date.now() - selection.capturedAtMs > selectionSnapshotLifetimeMs)) {
      throw new UserFacingError("queue.snapshot.required", "Queue 列表已失效，请重新执行 /queue list");
    }
    const item = snapshot.items.find((candidate) => candidate.id === selectedId);
    if (!item) {
      throw new UserFacingError(
        "queue.item-not-found",
        "找不到指定 Queue 条目，请使用完整 ID 或刷新 /queue list",
      );
    }
    return { snapshot, item };
  }

  private async resolveSelector(
    target: ConversationTarget,
    threadId: string,
    selector: string,
    beforeSubmit: () => void,
  ): Promise<ThreadQueueItem> {
    const resolved = await this.resolveSelectorSnapshot(target, threadId, selector, beforeSubmit);
    beforeSubmit();
    return resolved.item;
  }

  private rememberSelectionSnapshot(
    target: ConversationTarget,
    threadId: string,
    itemIds: string[],
  ): void {
    const now = Date.now();
    for (const [key, snapshot] of this.selectionSnapshots) {
      if (now - snapshot.capturedAtMs > selectionSnapshotLifetimeMs) {
        this.selectionSnapshots.delete(key);
      }
    }
    const key = conversationTargetKey(target);
    this.selectionSnapshots.delete(key);
    this.selectionSnapshots.set(key, {
      threadId,
      itemIds,
      capturedAtMs: now,
    });
    trimOldestEntries(this.selectionSnapshots, maximumSelectionSnapshots);
  }
}

function normalizeQueueText(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new UserFacingError("message.empty", "消息不能为空");
  }
  return normalized;
}

export function queueUserFacingError(
  error: unknown,
  operation: "add" | "list" | "update" | "delete" | "reorder" | "start",
): UserFacingError {
  if (error instanceof UserFacingError) return error;
  const failure = error instanceof ThreadQueueError ? error.failure : undefined;
  if (failure === "unavailable") {
    return new UserFacingError("queue.unavailable", "当前 App Server 不提供持久队列");
  }
  if (failure === "empty") {
    return new UserFacingError("queue.empty", "App Server Queue 为空");
  }
  if (failure === "full") {
    return new UserFacingError("queue.full", "原生 Queue 已达到 100 条上限");
  }
  if (failure === "busy") {
    return new UserFacingError(
      "queue.busy",
      "当前 Session 有活动或待触发 Turn，请稍后重试",
    );
  }
  if (failure === "item-not-found") {
    return new UserFacingError(
      "queue.item-not-found",
      "找不到指定 Queue 条目，请刷新 /queue list",
    );
  }
  if (failure === "reorder-conflict") {
    return new UserFacingError(
      "queue.reorder-conflict",
      "Queue 已发生变化，请刷新 /queue list 后重试排序",
    );
  }
  const labels: Record<typeof operation, string> = {
    add: "新增",
    list: "读取",
    update: "更新",
    delete: "删除",
    reorder: "排序",
    start: "启动",
  };
  return new UserFacingError("queue.failed", `Queue ${labels[operation]}失败，请稍后重试`);
}
