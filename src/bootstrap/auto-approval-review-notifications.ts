import type { AutoApprovalReviewEvent } from "../codex-client/index.js";
import type { ConversationTarget, OutputEvent } from "../conversation-core/index.js";

interface ParentRun {
  agentThreadId: string;
  agentTurnId: string;
  parentThreadId: string;
  parentTurnId: string;
}

interface ReviewRoute {
  threadId: string;
  turnId: string;
  target: ConversationTarget;
  provider: string;
}

const observationTtlMs = 60_000;
const maximumPending = 128;
const maximumRelations = 512;
const maximumSent = 2_048;
const runKey = (threadId: string, turnId: string) => JSON.stringify([threadId, turnId]);

/** Only routes safe completion facts; neither metrics persistence nor platform I/O owns this path. */
export class AutoApprovalReviewNotifications {
  private readonly parents = new Map<string, (ParentRun & { owner?: ReviewRoute }) | null>();
  private readonly origins = new Map<string, { threadId: string; turnId: string; owner?: ReviewRoute }>();
  private readonly pending = new Map<string, { review: AutoApprovalReviewEvent; expiresAt: number }>();
  private readonly sent = new Set<string>();

  constructor(private readonly options: {
    targetForThread: (threadId: string) => ConversationTarget | undefined;
    isBackgroundThread: (threadId: string) => boolean;
    providerForThread: (threadId: string) => string | undefined;
    publish: (event: Extract<OutputEvent, { type: "autoApprovalReview.updated" }>) => void;
    unroutable: (threadId: string, turnId: string, reason: "awaiting-attribution" | "expired" | "capacity" | "conflict" | "reset" | "publish-failed") => void;
  }) {}

  handle(review: AutoApprovalReviewEvent): void {
    // A review may start midway through an older Turn; it cannot establish that Turn's binding.
    this.observeRun(review.threadId, review.turnId, false);
    if (review.phase !== "completed") return;
    this.prune();
    const key = JSON.stringify([review.threadId, review.turnId, review.reviewId, review.phase]);
    if (this.sent.has(key) || this.pending.has(key)) return;
    if (this.deliver(review, key)) return;
    this.options.unroutable(review.threadId, review.turnId, "awaiting-attribution");
    this.pending.set(key, { review, expiresAt: Date.now() + observationTtlMs });
    while (this.pending.size > maximumPending) {
      const oldest = this.pending.keys().next().value!;
      const dropped = this.pending.get(oldest)!.review;
      this.pending.delete(oldest);
      this.options.unroutable(dropped.threadId, dropped.turnId, "capacity");
    }
  }

  /** Only turn.started may establish ownership; activity within an existing Turn cannot. */
  observeParentRun(threadId: string, turnId: string): void {
    this.observeRun(threadId, turnId, true);
  }

  private observeRun(threadId: string, turnId: string, captureCurrentBinding: boolean): void {
    const key = runKey(threadId, turnId);
    if (this.origins.has(key)) return;
    const owner = this.route({ threadId, turnId }, captureCurrentBinding);
    this.origins.set(key, { threadId, turnId, ...(owner ? { owner } : {}) });
    while (this.origins.size > maximumRelations) {
      const oldest = this.origins.keys().next().value!;
      const dropped = this.origins.get(oldest)!;
      this.origins.delete(oldest);
      this.options.unroutable(dropped.threadId, dropped.turnId, "capacity");
    }
  }

  recordRun(details: ParentRun): void {
    this.prune();
    const key = runKey(details.agentThreadId, details.agentTurnId);
    const previous = this.parents.get(key);
    if (previous === null || (previous && (previous.parentThreadId !== details.parentThreadId || previous.parentTurnId !== details.parentTurnId))) {
      this.parents.set(key, null);
      this.options.unroutable(details.agentThreadId, details.agentTurnId, "conflict");
      return;
    }
    const provider = this.options.providerForThread(details.agentThreadId);
    if (!provider || provider !== this.options.providerForThread(details.parentThreadId)) {
      this.options.unroutable(details.agentThreadId, details.agentTurnId, "conflict");
      return;
    }
    const owner = previous?.owner ?? this.origins.get(runKey(details.parentThreadId, details.parentTurnId))?.owner
      ?? this.route({ threadId: details.parentThreadId, turnId: details.parentTurnId });
    this.parents.set(key, { ...details, ...(owner ? { owner } : {}) });
    while (this.parents.size > maximumRelations) {
      const oldest = this.parents.keys().next().value!;
      const dropped = this.parents.get(oldest);
      this.parents.delete(oldest);
      if (dropped) this.options.unroutable(dropped.agentThreadId, dropped.agentTurnId, "capacity");
    }
    for (const [pendingKey, entry] of this.pending) {
      if (this.deliver(entry.review, pendingKey)) this.pending.delete(pendingKey);
    }
  }

  reset(provider?: string): void {
    for (const [key, { review }] of this.pending) {
      if (provider !== undefined && this.options.providerForThread(review.threadId) !== provider) continue;
      this.options.unroutable(review.threadId, review.turnId, "reset");
      this.pending.delete(key);
    }
    for (const [key, parent] of this.parents) {
      const threadId = parent?.agentThreadId ?? (JSON.parse(key) as [string, string])[0];
      if (provider === undefined || this.options.providerForThread(threadId) === provider
        || (parent && this.options.providerForThread(parent.parentThreadId) === provider)) this.parents.delete(key);
    }
    for (const [key, origin] of this.origins) {
      if (provider === undefined || this.options.providerForThread(origin.threadId) === provider) this.origins.delete(key);
    }
    // Keep recent sent completions through reconnects to suppress duplicate notifications.
  }

  private route(review: Pick<AutoApprovalReviewEvent, "threadId" | "turnId">, captureCurrentBinding = false): ReviewRoute | undefined {
    const provider = this.options.providerForThread(review.threadId);
    if (!provider) return undefined;
    let threadId = review.threadId;
    let turnId = review.turnId;
    const visited = new Set<string>();
    while (!visited.has(runKey(threadId, turnId))) {
      const key = runKey(threadId, turnId);
      visited.add(key);
      if (this.options.providerForThread(threadId) !== provider) return undefined;
      const parent = this.parents.get(key);
      if (parent === null) return undefined;
      const origin = this.origins.get(key);
      const owner = origin?.owner ?? parent?.owner;
      if (owner) {
        const current = this.options.targetForThread(owner.threadId);
        if (!current || current.surface !== owner.target.surface || current.accountId !== owner.target.accountId
          || current.conversationId !== owner.target.conversationId || owner.provider !== provider
          || this.options.providerForThread(owner.threadId) !== owner.provider) return undefined;
        return owner;
      }
      // Only turn.started may capture a binding, never mid-Turn activity, a review or late attribution.
      const target = captureCurrentBinding && !origin ? this.options.targetForThread(threadId) : undefined;
      if (target) return { threadId, turnId, target: { ...target }, provider };
      if (!parent) return undefined;
      threadId = parent.parentThreadId;
      turnId = parent.parentTurnId;
      captureCurrentBinding = false;
    }
    return undefined;
  }

  private deliver(review: AutoApprovalReviewEvent, key: string): boolean {
    if (review.phase !== "completed") return true;
    const route = this.route(review);
    if (!route) return false;
    try { this.options.publish({
      type: "autoApprovalReview.updated", threadId: route.threadId, turnId: route.turnId, target: route.target,
      sourceThreadId: review.threadId, sourceTurnId: review.turnId,
      reviewId: review.reviewId, phase: review.phase, status: review.status,
      ...(review.details ? { details: review.details } : {}),
      ...(this.options.isBackgroundThread(route.threadId) ? { background: true } : {}),
    }); } catch {
      this.options.unroutable(review.threadId, review.turnId, "publish-failed");
      return false;
    }
    this.sent.add(key);
    while (this.sent.size > maximumSent) this.sent.delete(this.sent.values().next().value!);
    return true;
  }

  private prune(): void {
    for (const [key, { review, expiresAt }] of this.pending) {
      if (expiresAt > Date.now()) continue;
      this.pending.delete(key);
      this.options.unroutable(review.threadId, review.turnId, "expired");
    }
  }
}
