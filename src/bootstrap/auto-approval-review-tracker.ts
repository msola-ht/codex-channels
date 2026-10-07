import { toAutoApprovalReviewEvent, toConversationInputEvent, type RpcNotification } from "../codex-client/index.js";
import type { AutoApprovalReviewStore, AutoApprovalReviewSummary } from "../observability/index.js";

/** Collects every routed Thread, including agents without a Surface binding. */
export class AutoApprovalReviewTracker {
  private failedObservation = false;

  constructor(
    private readonly store: AutoApprovalReviewStore,
    private readonly providerForThread: (threadId: string) => string | undefined,
    private readonly failed: (error: unknown, threadId?: string) => void,
  ) {}

  handleNotification(notification: RpcNotification): void {
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
    try {
      if (review) this.store.recordAutoApprovalReview(review, provider);
      else if (turn?.type === "turn.started" || turn?.type === "turn.completed") {
        this.store.observeAutoApprovalTurn(threadId, turn.turnId, provider,
          turn.type === "turn.started" ? "started" : "completed");
      }
    } catch (error) {
      this.failedObservation = true;
      this.failed(error, threadId);
      this.reset(provider);
    }
  }

  reset(provider?: string): void {
    try { this.store.invalidateAutoApprovalCoverage(provider); }
    catch (error) { this.failedObservation = true; this.failed(error); }
  }

  markIncomplete(): void {
    this.failedObservation = true;
    this.reset();
  }

  summary(threadId: string, turnId: string, pendingParentTurns?: readonly { threadId: string; turnId: string }[]): AutoApprovalReviewSummary {
    const summary = this.store.taskAutoApprovalReviewSummary(threadId, turnId, pendingParentTurns);
    return this.failedObservation && summary.coverage === "complete"
      ? { ...summary, coverage: "partial" } : summary;
  }

  sessionSummary(threadId: string, pendingParentTurns?: readonly { threadId: string; turnId: string }[]): AutoApprovalReviewSummary {
    const summary = this.store.sessionAutoApprovalReviewSummary(threadId, pendingParentTurns);
    return this.failedObservation && summary.coverage === "complete"
      ? { ...summary, coverage: "partial" } : summary;
  }
}
