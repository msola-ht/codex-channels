import { randomUUID } from "node:crypto";

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
import type {
  ThreadQueueItem,
  ThreadQueuePage,
  ThreadQueuePort,
} from "./thread-queue-port.js";

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

  add(target: ConversationTarget, value: string): Promise<ThreadQueueItem> {
    return this.locks.forConversation(target, async () => {
      const threadId = this.requireCurrentThread(target);
      const queue = this.requireQueue();
      this.rejectPendingOverrides(target);
      const text = normalizeQueueText(value);
      try {
        const item = await queue.addQueueItem(
          threadId,
          text,
          `${gatewayUserMessageClientIdPrefix}${randomUUID()}`,
        );
        this.invalidateSnapshot(threadId);
        return item;
      } catch (error) {
        throw queueUserFacingError(error, "add");
      }
    });
  }

  list(target: ConversationTarget, page = 1): Promise<ThreadQueueListResult> {
    return this.locks.forConversation(target, async () => {
      if (!Number.isSafeInteger(page) || page < 1 || page > maximumNativeQueuePages) {
        throw new UserFacingError("queue.usage", "Queue 页码无效");
      }
      const threadId = this.requireCurrentThread(target);
      const snapshot = await this.readSnapshot(target, threadId);
      const pageCount = Math.max(1, Math.ceil(snapshot.items.length / nativeQueuePageSize));
      const start = (page - 1) * nativeQueuePageSize;
      const items = page <= pageCount
        ? snapshot.items.slice(start, start + nativeQueuePageSize)
        : [];
      return {
        items,
        selectors: items.map((_item, index) => String(start + index + 1)),
        page,
        pageCount,
        totalItemCount: snapshot.items.length,
      };
    });
  }

  update(
    target: ConversationTarget,
    selector: string,
    value: string,
  ): Promise<ThreadQueueItem> {
    return this.locks.forConversation(target, async () => {
      const threadId = this.requireCurrentThread(target);
      const queue = this.requireQueue();
      const item = await this.resolveSelector(target, threadId, selector);
      if (!item.editable) {
        throw new UserFacingError(
          "queue.item-not-editable",
          "该 Queue 条目不是纯文本，不能更新",
        );
      }
      const text = normalizeQueueText(value);
      try {
        const updated = await queue.updateQueueItem(threadId, item.id, text);
        this.invalidateSnapshot(threadId);
        return updated;
      } catch (error) {
        throw queueUserFacingError(error, "update");
      }
    });
  }

  delete(
    target: ConversationTarget,
    selector: string,
  ): Promise<{ deleted: boolean }> {
    return this.locks.forConversation(target, async () => {
      const threadId = this.requireCurrentThread(target);
      const queue = this.requireQueue();
      const item = await this.resolveSelector(target, threadId, selector);
      try {
        const result = await queue.deleteQueueItem(threadId, item.id);
        this.invalidateSnapshot(threadId);
        return result;
      } catch (error) {
        throw queueUserFacingError(error, "delete");
      }
    });
  }

  reorder(
    target: ConversationTarget,
    selector: string,
    position: number,
  ): Promise<ThreadQueueReorderResult> {
    return this.locks.forConversation(target, async () => {
      const threadId = this.requireCurrentThread(target);
      const queue = this.requireQueue();
      const resolved = await this.resolveSelectorSnapshot(target, threadId, selector);
      const { snapshot, item } = resolved;
      if (!Number.isSafeInteger(position) || position < 1 || position > snapshot.items.length) {
        throw new UserFacingError("queue.position.invalid", "Queue 目标位置超出当前队列范围");
      }
      const ids = snapshot.items.map((entry) => entry.id).filter((id) => id !== item.id);
      ids.splice(position - 1, 0, item.id);
      try {
        await queue.reorderQueue(threadId, ids);
        this.invalidateSnapshot(threadId);
        return { itemId: item.id, position, totalItemCount: snapshot.items.length };
      } catch (error) {
        this.invalidateSnapshot(threadId);
        throw queueUserFacingError(error, "reorder");
      }
    });
  }

  start(
    target: ConversationTarget,
    selector?: string,
  ): Promise<{ turnId: string }> {
    return this.locks.forConversation(target, async () => {
      const threadId = this.requireCurrentThread(target);
      const queue = this.requireQueue();
      this.rejectPendingOverrides(target);
      let queuedSubmissionId: string | undefined;
      if (selector?.trim()) {
        queuedSubmissionId = (
          await this.resolveSelectorSnapshot(target, threadId, selector)
        ).item.id;
      }
      try {
        const result = await queue.startQueueItem(threadId, queuedSubmissionId);
        this.invalidateSnapshot(threadId);
        return result;
      } catch (error) {
        throw queueUserFacingError(error, "start");
      }
    });
  }

  invalidateSnapshot(threadId: string): void {
    for (const [key, snapshot] of this.selectionSnapshots) {
      if (snapshot.threadId === threadId) {
        this.selectionSnapshots.delete(key);
      }
    }
  }

  clearSnapshot(target: ConversationTarget): void {
    this.selectionSnapshots.delete(conversationTargetKey(target));
  }

  async rejectPendingOverrideChange(target: ConversationTarget): Promise<void> {
    const threadId = this.router.current?.(target)?.threadId;
    if (!threadId || !this.queue) return;
    if (await this.hasItems(threadId)) {
      throw new UserFacingError(
        "queue.pending-overrides",
        "Queue 与待生效的模型、思考、Fast 或 Plan 选择不能同时存在；请先让其中一方处理完成",
      );
    }
  }

  async hasItems(threadId: string): Promise<boolean> {
    if (!this.queue) return false;
    try {
      const page = await this.queue.listQueue(threadId, { limit: 1 });
      return page.items.length > 0 || page.nextCursor !== null;
    } catch (error) {
      const mapped = queueUserFacingError(error, "list");
      if (mapped.code === "queue.unavailable") return false;
      throw mapped;
    }
  }

  private requireCurrentThread(target: ConversationTarget): string {
    const binding = this.router.current(target);
    if (!binding) {
      throw new UserFacingError("conversation.missing", "当前还没有 Codex Thread");
    }
    return binding.threadId;
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
    target: ConversationTarget,
    threadId: string,
  ): Promise<{ items: ThreadQueueItem[] }> {
    const queue = this.requireQueue();
    let response: ThreadQueuePage;
    try {
      response = await queue.listQueue(threadId, { limit: maximumNativeQueueItems });
    } catch (error) {
      throw queueUserFacingError(error, "list");
    }
    if (response.items.length > maximumNativeQueueItems || response.nextCursor !== null) {
      throw new UserFacingError(
        "queue.unavailable",
        "当前 App Server 返回了不完整或超过 100 条的 Queue 页面",
      );
    }
    const items = response.items;
    this.rememberSelectionSnapshot(target, threadId, items.map((item) => item.id));
    return { items };
  }

  private async resolveSelectorSnapshot(
    target: ConversationTarget,
    threadId: string,
    selector: string,
  ): Promise<{ snapshot: { items: ThreadQueueItem[] }; item: ThreadQueueItem }> {
    const normalized = selector.trim();
    let selectedId = normalized;
    if (/^\d+$/u.test(normalized)) {
      const selection = this.selectionSnapshots.get(conversationTargetKey(target));
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
    const snapshot = await this.readSnapshot(target, threadId);
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
  ): Promise<ThreadQueueItem> {
    return (await this.resolveSelectorSnapshot(target, threadId, selector)).item;
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
    while (this.selectionSnapshots.size > maximumSelectionSnapshots) {
      const oldest = this.selectionSnapshots.keys().next().value;
      if (oldest === undefined) break;
      this.selectionSnapshots.delete(oldest);
    }
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
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("user message queue is unavailable")) {
    return new UserFacingError("queue.unavailable", "当前 App Server 不提供持久队列");
  }
  if (message.includes("queue is empty")) {
    return new UserFacingError("queue.empty", "App Server Queue 为空");
  }
  if (message.includes("cannot contain more than 100")) {
    return new UserFacingError("queue.full", "原生 Queue 已达到 100 条上限");
  }
  if (message.includes("active or pending turn")) {
    return new UserFacingError(
      "queue.busy",
      "当前 Thread 有活动或待触发 Turn，请稍后重试",
    );
  }
  if (message.includes("queued submission not found")) {
    return new UserFacingError(
      "queue.item-not-found",
      "找不到指定 Queue 条目，请刷新 /queue list",
    );
  }
  if (message.includes("reorder must include every")) {
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
