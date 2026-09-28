import type { ConversationInputEvent } from "../conversation-core/index.js";
import type { ConversationService } from "./conversation-service.js";

type ConversationEventUseCases = Pick<ConversationService,
  | "invalidateQueueSnapshot"
  | "invalidateRevertSnapshot"
  | "invalidateSessionDisplayCache"
  | "clearPendingSelectionsForThread"
  | "markLunaReserveUsageLimit"
  | "clearLunaReserveThread"
  | "clearLunaReserveAccountState"
  | "recoverLunaReserveAfterTurn"
>;

interface ConversationEventEffects {
  trackSubagent(event: ConversationInputEvent): void;
  reduce(event: ConversationInputEvent): void;
  isBackgroundThread(threadId: string): boolean;
  /** Schedule with the Gateway lifecycle owner; never await RPCs in the input path. */
  retryBackgroundRelease(threadId: string, trigger: "thread-idle" | "subagent-terminal"): void;
}

/** Applies conversation policies around Core reduction, preserving notification order. */
export class ConversationEventCoordinator {
  constructor(
    private readonly conversations: ConversationEventUseCases,
    private readonly effects: ConversationEventEffects,
  ) {}

  queueChanged(threadId: string): void {
    this.conversations.invalidateQueueSnapshot(threadId);
    this.conversations.invalidateRevertSnapshot(threadId);
  }

  handle(event: ConversationInputEvent): void {
    if (
      event.type === "turn.started"
      || event.type === "turn.completed"
      || event.type === "thread.reverted"
      || event.type === "thread.closed"
      || event.type === "thread.archived"
      || event.type === "thread.deleted"
    ) {
      this.conversations.invalidateRevertSnapshot(event.threadId);
    }
    if (
      event.type === "turn.started"
      || event.type === "turn.completed"
      || event.type === "thread.reverted"
    ) {
      // The display cache is derived data. Invalidate before any list command
      // can observe a stale count, including Turns started by the native TUI.
      this.conversations.invalidateSessionDisplayCache(event.threadId);
    }
    if (event.type === "turn.started") {
      // A TUI or another App Server client may have consumed a native Queue
      // entry. Pending model/effort/Fast/Plan choices are Conversation-local
      // and must not leak into the next direct Turn after that dispatch.
      this.conversations.clearPendingSelectionsForThread(event.threadId);
    }
    if (
      event.type === "turn.error"
      && !event.willRetry
      && event.errorCode === "usageLimitExceeded"
    ) {
      this.conversations.markLunaReserveUsageLimit(event.threadId, event.turnId);
    }
    if (
      event.type === "turn.completed"
      && event.errorCode === "usageLimitExceeded"
    ) {
      this.conversations.markLunaReserveUsageLimit(event.threadId, event.turnId);
    }
    if (
      event.type === "thread.closed"
      || event.type === "thread.archived"
      || event.type === "thread.deleted"
    ) {
      this.conversations.clearLunaReserveThread(event.threadId);
    }
    if (
      event.type === "account.updated"
      && (event.modelProvider ?? "openai") === "openai"
    ) {
      this.conversations.clearLunaReserveAccountState();
    }
    if (event.type === "thread.status.changed" && event.status !== "active") {
      // A completion can race the native idle contributor. Retry only a
      // marked background release, without making the App Server reader
      // await any RPC or platform output.
      this.effects.retryBackgroundRelease(event.threadId, "thread-idle");
    }
    this.effects.trackSubagent(event);
    if (
      event.type === "item.subagentActivity"
      && (event.kind === "completed" || event.kind === "interrupted")
      && this.effects.isBackgroundThread(event.threadId)
    ) {
      this.effects.retryBackgroundRelease(event.threadId, "subagent-terminal");
    }
    this.effects.reduce(event);
    if (event.type === "turn.completed") {
      this.conversations.recoverLunaReserveAfterTurn(event.threadId, event.turnId);
    }
  }
}
