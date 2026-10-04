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
  InteractionRoutingGuard,
} from "./types.js";

interface RoutingGuardState {
  threadId: string;
  ports: Map<string, InteractionPort>;
  cancelledThreads: Set<string>;
  cancelled: boolean;
  targetKey?: string;
  relatedThreadIds?: readonly string[];
  cancel(): void;
}

interface QueuedInteraction {
  target: ConversationTarget;
  request: InteractionRequest;
  port: InteractionPort;
  queueKey: string;
  active: boolean;
  deadline: number;
  timer?: NodeJS.Timeout;
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
  private readonly routingGuards = new Set<RoutingGuardState>();

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
        this.setAvailable(surface, accountId, false, "渠道交互端口已注销");
        this.ports.delete(key);
        this.unavailablePorts.delete(key);
      }
    };
  }

  captureRoutingGuard(threadId: string, cancel: () => void): InteractionRoutingGuard {
    if (this.routingGuards.size >= this.capacity) {
      this.cleanup(cancel);
      return { isCurrent: () => false, release: () => {} };
    }
    const guard: RoutingGuardState = {
      threadId, cancel, cancelled: false, cancelledThreads: new Set(),
      ports: new Map([...this.ports].filter(([key]) => !this.unavailablePorts.has(key))),
    };
    this.routingGuards.add(guard);
    return {
      isCurrent: (target, relatedThreadIds) => {
        const key = this.key(target.surface, target.accountId);
        guard.targetKey = key;
        guard.relatedThreadIds = relatedThreadIds;
        return !guard.cancelled && this.routingGuards.has(guard)
          && guard.ports.has(key) && guard.ports.get(key) === this.ports.get(key)
          && !this.unavailablePorts.has(key)
          && !relatedThreadIds.some(id => guard.cancelledThreads.has(id));
      },
      release: () => { this.routingGuards.delete(guard); },
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
    // Remove the original registration permanently, including across a quick reconnect.
    for (const guard of this.routingGuards) {
      guard.ports.delete(key);
      if (guard.targetKey === key) guard.cancelled = true;
    }
    this.cancelMatching(
      (queued) => this.key(queued.target.surface, queued.target.accountId) === key,
      () => this.cleanup(() => this.ports.get(key)?.cancelAll?.(outcome)),
    );
  }

  request(
    target: ConversationTarget,
    request: InteractionRequest,
  ): Promise<InteractionDecision> {
    if (request.isCurrent?.() === false) {
      this.warnRejected(target, request, "stale-interaction-owner");
      return Promise.resolve(safeInteractionDecision(request));
    }
    if (!Number.isFinite(request.expiresInMs) || request.expiresInMs <= 0 || request.expiresInMs > 2_147_483_647) {
      this.warnRejected(target, request, "invalid-interaction-lifetime");
      return Promise.resolve(safeInteractionDecision(request));
    }
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
      const queueKey = this.conversationKey(target)
        + (request.type === "user-input" && request.asynchronous ? "\u0000async" : "\u0000blocking");
      const queue = this.queues.get(queueKey) ?? {
        entries: [],
      };
      if (!this.queues.has(queueKey)) {
        this.queues.set(queueKey, queue);
      }
      const decision = new Promise<InteractionDecision>((resolve, reject) => {
        const queued: QueuedInteraction = {
          target,
          request,
          port,
          queueKey,
          active: false,
          deadline: performance.now() + request.expiresInMs,
          resolve,
          reject,
        };
        queue.entries.push(queued);
        this.pendingByRequestId.set(request.requestId, queued);
        queued.timer = setTimeout(() => this.expire(queued), request.expiresInMs);
        queued.timer.unref();
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
      this.cancelMatching((candidate) => candidate === queued);
      return;
    }
    for (const port of this.ports.values()) {
      this.cleanup(() => port.resolved?.(requestId));
    }
  }

  resolvedMany(requestIds: ReadonlySet<string>): void {
    this.cancelMatching((queued) => requestIds.has(queued.request.requestId));
  }

  hasPendingForThread(threadId: string): boolean {
    for (const pending of this.pendingByRequestId.values()) {
      if (pending.request.threadId === threadId || pending.request.relatedThreadIds?.includes(threadId)) {
        return true;
      }
    }
    return false;
  }

  cancelThreads(threadIds: ReadonlySet<string>): void {
    const cancelled: RoutingGuardState[] = [];
    for (const guard of this.routingGuards) {
      if (guard.relatedThreadIds) {
        if (guard.relatedThreadIds.some(id => threadIds.has(id))) guard.cancelled = true;
      } else {
        for (const id of threadIds) {
          guard.cancelledThreads.add(id);
          if (id === guard.threadId || guard.cancelledThreads.size > 1_024) {
            guard.cancelled = true;
            break;
          }
        }
      }
      if (guard.cancelled) {
        this.routingGuards.delete(guard);
        cancelled.push(guard);
      }
    }
    this.cancelMatching((queued) => threadIds.has(queued.request.threadId)
      || queued.request.relatedThreadIds?.some(id => threadIds.has(id)) === true);
    // All queued matches and guards are invalid before callbacks can advance a queue.
    for (const guard of cancelled) if (!guard.relatedThreadIds) this.cleanup(() => guard.cancel());
  }

  cancelAll(outcome?: string): void {
    const guards = [...this.routingGuards];
    for (const guard of guards) guard.cancelled = true;
    this.routingGuards.clear();
    this.cancelMatching(() => true, () => {
      for (const port of this.ports.values()) {
        this.cleanup(() => port.cancelAll?.(outcome));
      }
    });
    for (const guard of guards) if (!guard.relatedThreadIds) this.cleanup(() => guard.cancel());
  }

  private cancelMatching(
    matches: (queued: QueuedInteraction) => boolean,
    cancelPorts?: () => void,
  ): void {
    const cancelled = [...this.pendingByRequestId.values()].filter(matches);
    const queues = new Map<string, ConversationInteractionQueue>();
    // Remove the entire batch before advancing any Conversation or calling a Surface.
    for (const queued of cancelled) {
      clearTimeout(queued.timer);
      this.pendingByRequestId.delete(queued.request.requestId);
      const queue = this.queues.get(queued.queueKey);
      if (queue) {
        queues.set(queued.queueKey, queue);
        if (queue.active === queued) {
          delete queue.active;
        } else {
          const index = queue.entries.indexOf(queued);
          if (index >= 0) queue.entries.splice(index, 1);
        }
      }
      queued.resolve(safeInteractionDecision(queued.request));
    }
    cancelPorts?.();
    for (const queued of cancelled) {
      // Preparing cards are not yet covered by the Surface's active-interaction list.
      if (queued.active) this.cleanup(() => queued.port.resolved?.(queued.request.requestId));
    }
    for (const [key, queue] of queues) this.dispatchNext(key, queue);
  }

  private cleanup(run: () => void): void {
    try {
      run();
    } catch {
      this.logger?.warn(
        { reason: "surface-cleanup-failed" },
        "Surface 交互清理失败，请求已安全取消",
      );
    }
  }

  private expire(queued: QueuedInteraction): void {
    if (this.pendingByRequestId.get(queued.request.requestId) !== queued) return;
    this.warnRejected(queued.target, queued.request, "interaction-deadline-exceeded");
    this.cancelMatching((candidate) => candidate === queued);
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
      "Codex 交互请求已安全拒绝或取消",
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
      if (this.queues.get(queueKey) === queue) this.queues.delete(queueKey);
      return;
    }
    queue.active = next;
    if (next.request.isCurrent?.() === false) {
      this.warnRejected(next.target, next.request, "stale-interaction-owner");
      this.cancelMatching(candidate => candidate === next);
      return;
    }
    const remainingMs = next.deadline - performance.now();
    if (remainingMs <= 0) {
      this.expire(next);
      return;
    }
    next.active = true;
    const complete = (settle: () => void): void => {
      if (this.pendingByRequestId.get(next.request.requestId) === next) {
        if (next.request.isCurrent?.() === false) {
          this.warnRejected(next.target, next.request, "stale-interaction-owner");
          this.cancelMatching(candidate => candidate === next);
          return;
        }
        // A late platform callback may run before an overdue timer after event-loop congestion.
        if (performance.now() >= next.deadline) {
          this.expire(next);
          return;
        }
        clearTimeout(next.timer);
        this.pendingByRequestId.delete(next.request.requestId);
        settle();
      }
      if (queue.active === next) {
        delete queue.active;
        this.dispatchNext(queueKey, queue);
      }
    };
    try {
      void next.port.request(next.target, {
        ...next.request,
        expiresInMs: Math.ceil(remainingMs),
      }).then(
        (decision) => complete(() => next.resolve(decision)),
        (error: unknown) => complete(() => next.reject(error)),
      );
    } catch (error) {
      complete(() => next.reject(error));
    }
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
