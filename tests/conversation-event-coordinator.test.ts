import { describe, expect, it, vi } from "vitest";
import { ConversationEventCoordinator } from "../src/application/index.js";
import type { ConversationInputEvent } from "../src/conversation-core/index.js";

function fixture(background = false) {
  const calls: string[] = [];
  const conversations = {
    invalidateQueueSnapshot: vi.fn(),
    invalidateRevertSnapshot: vi.fn(),
    invalidateSessionDisplayCache: vi.fn(() => { calls.push("invalidate-count"); }),
    clearPendingSelectionsForThread: vi.fn(() => { calls.push("clear-preferences"); }),
    markLunaReserveUsageLimit: vi.fn(() => { calls.push("mark-limit"); }),
    clearLunaReserveThread: vi.fn(),
    clearLunaReserveAccountState: vi.fn(),
    recoverLunaReserveAfterTurn: vi.fn(() => { calls.push("recover"); }),
  };
  const effects = {
    trackSubagent: vi.fn(() => { calls.push("track-subagent"); }),
    reduce: vi.fn(() => { calls.push("reduce"); }),
    isBackgroundThread: () => background,
    retryBackgroundRelease: vi.fn(() => { calls.push("release"); }),
  };
  return { coordinator: new ConversationEventCoordinator(conversations, effects), conversations, effects, calls };
}

describe("conversation event coordination", () => {
  it("invalidates native Queue selections without querying or reducing Core", () => {
    const { coordinator, conversations, effects } = fixture();
    coordinator.queueChanged("thread");
    expect(conversations.invalidateQueueSnapshot).toHaveBeenCalledWith("thread");
    expect(conversations.invalidateRevertSnapshot).toHaveBeenCalledWith("thread");
    expect(effects.reduce).not.toHaveBeenCalled();
  });

  it("invalidates counts and pending choices before a native Turn reaches Core", () => {
    const { coordinator, conversations, calls } = fixture();
    coordinator.handle({ type: "turn.started", threadId: "thread", turnId: "turn" });
    expect(conversations.invalidateRevertSnapshot).toHaveBeenCalledWith("thread");
    expect(conversations.clearPendingSelectionsForThread).toHaveBeenCalledWith("thread");
    expect(calls).toEqual(["invalidate-count", "clear-preferences", "track-subagent", "reduce"]);
  });

  it("records final usage limits before reduction and recovers only after Core becomes idle", () => {
    const { coordinator, conversations, calls } = fixture();
    coordinator.handle({
      type: "turn.completed", threadId: "thread", turnId: "turn", status: "failed",
      error: "limit", errorCode: "usageLimitExceeded",
    });
    expect(conversations.markLunaReserveUsageLimit).toHaveBeenCalledWith("thread", "turn");
    expect(conversations.recoverLunaReserveAfterTurn).toHaveBeenCalledWith("thread", "turn");
    expect(calls).toEqual(["invalidate-count", "mark-limit", "track-subagent", "reduce", "recover"]);
  });

  it.each([true, false])("distinguishes retrying errors from final errors: %s", (willRetry) => {
    const { coordinator, conversations } = fixture();
    coordinator.handle({
      type: "turn.error", threadId: "thread", turnId: "turn", message: "limit",
      errorCode: "usageLimitExceeded", willRetry,
    });
    expect(conversations.markLunaReserveUsageLimit).toHaveBeenCalledTimes(willRetry ? 0 : 1);
    expect(conversations.recoverLunaReserveAfterTurn).not.toHaveBeenCalled();
  });

  it.each(["thread.closed", "thread.archived", "thread.deleted"] as const)("clears only the affected Thread on %s", (type) => {
    const { coordinator, conversations } = fixture();
    coordinator.handle({ type, threadId: "thread" });
    expect(conversations.invalidateRevertSnapshot).toHaveBeenCalledWith("thread");
    expect(conversations.clearLunaReserveThread).toHaveBeenCalledWith("thread");
    expect(conversations.clearLunaReserveAccountState).not.toHaveBeenCalled();
  });

  it("invalidates Revert and count projections without clearing choices on history revert", () => {
    const { coordinator, conversations } = fixture();
    coordinator.handle({ type: "thread.reverted", threadId: "thread" });
    expect(conversations.invalidateRevertSnapshot).toHaveBeenCalledWith("thread");
    expect(conversations.invalidateSessionDisplayCache).toHaveBeenCalledWith("thread");
    expect(conversations.clearPendingSelectionsForThread).not.toHaveBeenCalled();
  });

  it.each([true, false])("records subagent terminal state before retrying background release: %s", (background) => {
    const { coordinator, effects, calls } = fixture(background);
    const event: ConversationInputEvent = {
      type: "item.subagentActivity", threadId: "parent", turnId: "turn", itemId: "item",
      agentThreadId: "child", agentPath: "worker", kind: "completed",
    };
    coordinator.handle(event);
    expect(calls).toEqual(background ? ["track-subagent", "release", "reduce"] : ["track-subagent", "reduce"]);
    if (background) expect(effects.retryBackgroundRelease).toHaveBeenCalledWith("parent", "subagent-terminal");
  });

  it.each(["active", "idle"])("requests release only for non-active status: %s", (status) => {
    const { coordinator, effects } = fixture();
    coordinator.handle({ type: "thread.status.changed", threadId: "thread", status });
    expect(effects.retryBackgroundRelease).toHaveBeenCalledTimes(status === "active" ? 0 : 1);
  });

  it.each([undefined, "openai", "other"])("scopes Reserve account invalidation to OpenAI: %s", (modelProvider) => {
    const { coordinator, conversations } = fixture();
    coordinator.handle({
      type: "account.updated", authMode: null, planType: null,
      ...(modelProvider ? { modelProvider } : {}),
    });
    expect(conversations.clearLunaReserveAccountState).toHaveBeenCalledTimes(modelProvider === "other" ? 0 : 1);
  });
});
