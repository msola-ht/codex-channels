import { toAutoApprovalReviewEvent, toConversationInputEvent, type RpcNotification } from "../codex-client/index.js";
import type { AsyncAutoApprovalReviewStore, AutoApprovalReviewSummary } from "../observability/index.js";

/** Collects every routed Thread, including agents without a Surface binding. */
export class AutoApprovalReviewTracker {
  private failedObservation = false;
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private invalidation: Promise<void> | undefined;

  constructor(
    private readonly store: AsyncAutoApprovalReviewStore,
    private readonly providerForThread: (threadId: string) => string | undefined,
    private readonly failed: (error: unknown, threadId?: string) => void,
    private readonly fatal: (error: unknown) => void = failed,
  ) {}

  handleNotification(notification: RpcNotification): void {
    if (this.stopped) return;
    const review = toAutoApprovalReviewEvent(notification);
    const turn = notification.method === "turn/started" || notification.method === "turn/completed"
      ? toConversationInputEvent(notification) : undefined;
    if ((!review && (notification.method === "item/autoApprovalReview/started" || notification.method === "item/autoApprovalReview/completed"))
      || (!turn && (notification.method === "turn/started" || notification.method === "turn/completed"))) {
      this.failedObservation = true;
      this.failed(new Error("自动审查统计所需的通知字段不受支持"));
      this.reset();
      return;
    }
    const threadId = review?.threadId ?? (turn && "threadId" in turn ? turn.threadId : undefined);
    if (!threadId) return;
    const provider = this.providerForThread(threadId);
    if (!provider) {
      this.markIncomplete();
      this.failed(new Error("自动审查事件缺少 Provider 归属"), threadId);
      return;
    }
    this.write(async () => {
      if (review) await this.store.recordAutoApprovalReview(review, provider);
      else if (turn?.type === "turn.started" || turn?.type === "turn.completed") {
        await this.store.observeAutoApprovalTurn(threadId, turn.turnId, provider,
          turn.type === "turn.started" ? "started" : "completed");
      }
    }, threadId);
  }

  reset(provider?: string): void {
    if (this.stopped) return;
    this.write(() => this.store.invalidateAutoApprovalCoverage(provider));
  }

  markIncomplete(): void {
    this.failedObservation = true;
    this.reset();
  }

  async summary(threadId: string, turnId: string, pendingParentTurns?: readonly { threadId: string; turnId: string }[], store = this.store): Promise<AutoApprovalReviewSummary> {
    const summary = await store.taskAutoApprovalReviewSummary(threadId, turnId, pendingParentTurns);
    return this.failedObservation && summary.coverage === "complete"
      ? { ...summary, coverage: "partial" } : summary;
  }

  async sessionSummary(threadId: string, pendingParentTurns?: readonly { threadId: string; turnId: string }[], store = this.store): Promise<AutoApprovalReviewSummary> {
    const summary = await store.sessionAutoApprovalReviewSummary(threadId, pendingParentTurns);
    return this.failedObservation && summary.coverage === "complete"
      ? { ...summary, coverage: "partial" } : summary;
  }

  private write(operation: () => Promise<void>, threadId?: string): void {
    if (this.pending.size >= 128) {
      this.failedObservation = true;
      this.failed(new Error("自动审查统计队列已满"), threadId);
      this.invalidateCoverage();
      return;
    }
    const task = operation().catch(error => {
      this.failedObservation = true;
      this.failed(error, threadId);
      this.invalidateCoverage();
    }).finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    let timer: NodeJS.Timeout | undefined;
    const settled = (async () => { await Promise.all(this.pending); await this.invalidation; })();
    try {
      await Promise.race([settled, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("自动审查统计停止尚未确认")), 5_000);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private invalidateCoverage(): void {
    if (this.invalidation) return;
    this.invalidation = Promise.all([...this.pending]).then(() => this.store.invalidateAutoApprovalCoverage())
      .catch(error => this.fatal(error)).finally(() => { this.invalidation = undefined; });
  }
}
