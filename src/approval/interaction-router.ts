import {
  surfaceAccountKey,
  type ConversationTarget,
  type SurfaceId,
} from "../conversation-core/index.js";
import type {
  InteractionAuditLogger,
  InteractionDecision,
  InteractionPort,
  InteractionRequest,
} from "./types.js";

interface QueuedInteraction {
  target: ConversationTarget;
  request: InteractionRequest;
  port: InteractionPort;
  queueKey: string;
  active: boolean;
  resolve(decision: InteractionDecision): void;
  reject(error: unknown): void;
}

interface ConversationInteractionQueue {
  active?: QueuedInteraction;
  entries: QueuedInteraction[];
}

const DEFAULT_INTERACTION_CAPACITY = 100;

export class InteractionRouter implements InteractionPort {
  private readonly ports = new Map<string, InteractionPort>();
  private readonly unavailablePorts = new Set<string>();
  private readonly queues = new Map<string, ConversationInteractionQueue>();
  private readonly pendingByRequestId = new Map<string, QueuedInteraction>();

  constructor(
    private readonly logger?: InteractionAuditLogger,
    private readonly capacity = DEFAULT_INTERACTION_CAPACITY,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("交互队列容量必须是正整数");
    }
  }

  register(surface: SurfaceId, accountId: string, port: InteractionPort): () => void {
    const key = this.key(surface, accountId);
    if (this.ports.has(key)) {
      throw new Error(`交互端口重复注册：${key}`);
    }
    this.ports.set(key, port);
    return () => {
      if (this.ports.get(key) === port) {
        this.ports.delete(key);
        this.unavailablePorts.delete(key);
      }
    };
  }

  setAvailable(
    surface: SurfaceId,
    accountId: string,
    available: boolean,
    outcome = "渠道连接已中断，请恢复后重试",
  ): void {
    const key = this.key(surface, accountId);
    if (available) {
      this.unavailablePorts.delete(key);
      return;
    }
    this.unavailablePorts.add(key);
    for (const queued of [...this.pendingByRequestId.values()]) {
      if (this.key(queued.target.surface, queued.target.accountId) !== key) {
        continue;
      }
      const queue = this.queues.get(queued.queueKey);
      if (queue?.active === queued) {
        delete queue.active;
      } else if (queue) {
        const index = queue.entries.indexOf(queued);
        if (index >= 0) {
          queue.entries.splice(index, 1);
        }
      }
      this.pendingByRequestId.delete(queued.request.requestId);
      queued.resolve(safeInteractionDecision(queued.request));
      if (queue && queue.active === undefined && queue.entries.length === 0) {
        this.queues.delete(queued.queueKey);
      }
    }
    try {
      this.ports.get(key)?.cancelAll?.(outcome);
    } catch (error) {
      this.logger?.warn(
        { surface, accountId, errorType: error instanceof Error ? error.name : typeof error },
        "不可用 Surface 的交互清理失败",
      );
    }
  }

  request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    const portKey = this.key(target.surface, target.accountId);
    const port = this.ports.get(portKey);
    if (port) {
      if (this.unavailablePorts.has(portKey)) {
        this.warnRejected(target, request, "surface-unavailable");
        return Promise.resolve(safeInteractionDecision(request));
      }
      if (this.pendingByRequestId.has(request.requestId)) {
        this.warnRejected(target, request, "duplicate-request-id");
        return Promise.resolve(safeInteractionDecision(request));
      }
      if (this.pendingByRequestId.size >= this.capacity) {
        this.warnRejected(target, request, "interaction-capacity-exceeded");
        return Promise.resolve(safeInteractionDecision(request));
      }
      const queueKey = this.conversationKey(target);
      const queue = this.queues.get(queueKey) ?? {
        entries: [],
      };
      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, queue);
      }
      const decision = new Promise<InteractionDecision>((resolve, reject) => {
        const queued = {
          target,
          request,
          port,
          queueKey,
          active: false,
          resolve,
          reject,
        };
        queue.entries.push(queued);
        this.pendingByRequestId.set(request.requestId, queued);
      });
      this.dispatchNext(queueKey, queue);
      return decision;
    }
    this.logger?.warn(
      {
        requestId: request.requestId,
        requestType: request.type,
        threadId: request.threadId,
        turnId: request.turnId,
        surface: target.surface,
        accountId: target.accountId,
        conversationId: target.conversationId,
        reason: "unregistered-surface-account",
      },
      "Codex 交互请求没有已注册的 Surface 端口，已安全拒绝",
    );
    return Promise.resolve(safeInteractionDecision(request));
  }

  resolved(requestId: string): void {
    const queued = this.pendingByRequestId.get(requestId);
    if (queued) {
      if (queued.active) {
        queued.port.resolved?.(requestId);
        return;
      }
      const queue = this.queues.get(queued.queueKey);
      if (queue) {
        const index = queue.entries.indexOf(queued);
        if (index >= 0) {
          queue.entries.splice(index, 1);
        }
      }
      this.pendingByRequestId.delete(requestId);
      queued.resolve(safeInteractionDecision(queued.request));
      return;
    }
    for (const port of this.ports.values()) {
      port.resolved?.(requestId);
    }
  }

  hasPendingForThread(threadId: string): boolean {
    for (const pending of this.pendingByRequestId.values()) {
      if (pending.request.threadId === threadId) {
        return true;
      }
    }
    return false;
  }

  cancelThreads(threadIds: ReadonlySet<string>): void {
    for (const queued of [...this.pendingByRequestId.values()]) {
      if (!threadIds.has(queued.request.threadId)) {
        continue;
      }
      const queue = this.queues.get(queued.queueKey);
      this.pendingByRequestId.delete(queued.request.requestId);
      if (queue?.active === queued) {
        delete queue.active;
        queued.port.resolved?.(queued.request.requestId);
      } else if (queue) {
        const index = queue.entries.indexOf(queued);
        if (index >= 0) queue.entries.splice(index, 1);
      }
      queued.resolve(safeInteractionDecision(queued.request));
      if (queue) {
        this.dispatchNext(queued.queueKey, queue);
      }
    }
  }

  cancelAll(outcome?: string): void {
    for (const queue of this.queues.values()) {
      for (const queued of queue.entries.splice(0)) {
        this.pendingByRequestId.delete(queued.request.requestId);
        queued.resolve(safeInteractionDecision(queued.request));
      }
    }
    for (const port of this.ports.values()) {
      port.cancelAll?.(outcome);
    }
  }

  private key(surface: SurfaceId, accountId: string): string {
    return surfaceAccountKey(surface, accountId);
  }

  private conversationKey(target: ConversationTarget): string {
    return `${surfaceAccountKey(target.surface, target.accountId)}\u0000${target.conversationId}`;
  }

  private warnRejected(
    target: ConversationTarget,
    request: InteractionRequest,
    reason: string,
  ): void {
    this.logger?.warn(
      {
        requestId: request.requestId,
        requestType: request.type,
        threadId: request.threadId,
        turnId: request.turnId,
        surface: target.surface,
        accountId: target.accountId,
        conversationId: target.conversationId,
        reason,
      },
      "Codex 交互请求未进入 Surface 队列，已安全拒绝",
    );
  }

  private dispatchNext(
    queueKey: string,
    queue: ConversationInteractionQueue,
  ): void {
    if (queue.active !== undefined) {
      return;
    }
    const next = queue.entries.shift();
    if (!next) {
      this.queues.delete(queueKey);
      return;
    }
    queue.active = next;
    next.active = true;
    void next.port.request(next.target, next.request).then(
      (decision) => {
        if (this.pendingByRequestId.get(next.request.requestId) === next) {
          this.pendingByRequestId.delete(next.request.requestId);
        }
        next.resolve(decision);
      },
      (error: unknown) => {
        next.reject(error);
      },
    ).finally(() => {
      if (this.pendingByRequestId.get(next.request.requestId) === next) {
        this.pendingByRequestId.delete(next.request.requestId);
      }
      if (queue.active === next) {
        delete queue.active;
        this.dispatchNext(queueKey, queue);
      }
    });
  }
}

export function safeInteractionDecision(
  request: InteractionRequest,
): InteractionDecision {
  switch (request.type) {
    case "approval":
      return { type: "approval", approved: false };
    case "user-input":
      return { type: "user-input", answers: {} };
    case "elicitation":
      return { type: "elicitation", action: "cancel", content: null };
  }
}
