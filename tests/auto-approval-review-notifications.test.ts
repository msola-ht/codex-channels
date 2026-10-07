import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoApprovalReviewNotifications } from "../src/bootstrap/auto-approval-review-notifications.js";
import { SubagentCompletionTracker } from "../src/bootstrap/subagent-completion-tracker.js";
import { toAutoApprovalReviewEvent } from "../src/codex-client/index.js";
import type { AutoApprovalReviewEvent } from "../src/codex-client/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";

const target = { surface: "telegram", accountId: "default", conversationId: "chat" } as const;
const review = (threadId = "root", turnId = "turn", phase: "started" | "completed" = "completed"): AutoApprovalReviewEvent => ({
  threadId, turnId, reviewId: "review", phase, status: phase === "started" ? "inProgress" : "approved", approved: phase === "completed",
});
function fixture() {
  const bindings = new Map<string, ConversationTarget>([["root", target]]);
  const providers = new Map<string, string>();
  const publish = vi.fn();
  const unroutable = vi.fn();
  const notifications = new AutoApprovalReviewNotifications({
    targetForThread: thread => bindings.get(thread), isBackgroundThread: () => false,
    providerForThread: thread => providers.get(thread) ?? "fixture", publish, unroutable,
  });
  notifications.observeParentRun("root", "turn");
  return { notifications, bindings, providers, publish, unroutable };
}
afterEach(() => vi.useRealTimers());

describe("safe automatic review channel notifications", () => {
  it("routes each phase once and prevents late starts from reverting completed reviews", () => {
    const { notifications, publish } = fixture();
    notifications.handle(review("root", "turn", "started"));
    notifications.handle(review("root", "turn", "started"));
    notifications.handle(review()); notifications.handle(review());
    notifications.handle(review("root", "turn", "started"));
    expect(publish.mock.calls.map(([event]) => event.status)).toEqual(["inProgress", "approved"]);
    notifications.handle(review("root", "other"));
    notifications.handle(review("root", "other", "started"));
    expect(publish.mock.calls.map(([event]) => event.status)).toEqual(["inProgress", "approved", "approved"]);
    notifications.reset(); notifications.handle(review());
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("routes late recursive run attribution while preserving source and authorized parent identities", () => {
    const { notifications, publish, unroutable } = fixture();
    notifications.handle(review("grandchild", "grand-turn", "started"));
    notifications.handle(review("grandchild", "grand-turn"));
    notifications.recordRun({ agentThreadId: "grandchild", agentTurnId: "grand-turn", parentThreadId: "child", parentTurnId: "child-turn" });
    expect(publish).not.toHaveBeenCalled();
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "turn" });
    expect(publish.mock.calls.map(([event]) => event.phase)).toEqual(["started", "completed"]);
    expect(publish.mock.calls[1]?.[0]).toEqual({ type: "autoApprovalReview.updated", target,
      threadId: "root", turnId: "turn", sourceThreadId: "grandchild", sourceTurnId: "grand-turn",
      reviewId: "review", phase: "completed", status: "approved" });
    notifications.handle(review("child", "unrelated-turn"));
    expect(publish).toHaveBeenCalledTimes(2);
    expect(unroutable).toHaveBeenCalledWith("child", "unrelated-turn", "awaiting-attribution");
  });

  it("drops a late start when a completed review is still awaiting a parent mapping", () => {
    const { notifications, publish } = fixture();
    notifications.handle(review("child", "child-turn"));
    notifications.handle(review("child", "child-turn", "started"));
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "turn" });
    expect(publish.mock.calls.map(([event]) => event.status)).toEqual(["approved"]);
  });

  it("uses the existing exact run tracker without treating contacted messages as parent ownership", () => {
    const { notifications, publish } = fixture();
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish: vi.fn(), onRunStarted: details => notifications.recordRun(details) });
    try {
      tracker.handleInput({ type: "item.subagentActivity", threadId: "root", turnId: "turn", itemId: "contact",
        kind: "interacted", agentThreadId: "contacted", agentPath: "/root/contacted" });
      tracker.handleInput({ type: "turn.started", threadId: "contacted", turnId: "contact-turn" });
      notifications.handle(review("contacted", "contact-turn"));
      expect(publish).not.toHaveBeenCalled();
      tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "child-turn" });
      notifications.handle(review("child", "child-turn"));
      tracker.handleInput({ type: "item.subagentActivity", threadId: "root", turnId: "turn", itemId: "spawn",
        kind: "started", agentThreadId: "child", agentPath: "/root/child" });
      expect(publish).toHaveBeenCalledOnce();
    } finally { tracker.close(); }
  });

  it("rejects cycles, provider conflicts and withdrawn bindings", () => {
    const { notifications, bindings, providers, publish, unroutable } = fixture();
    notifications.recordRun({ agentThreadId: "a", agentTurnId: "a-turn", parentThreadId: "b", parentTurnId: "b-turn" });
    notifications.recordRun({ agentThreadId: "b", agentTurnId: "b-turn", parentThreadId: "a", parentTurnId: "a-turn" });
    notifications.handle(review("a", "a-turn"));
    providers.set("other-provider", "other");
    notifications.recordRun({ agentThreadId: "other-provider", agentTurnId: "other-turn", parentThreadId: "root", parentTurnId: "turn" });
    notifications.handle(review("other-provider", "other-turn"));
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "turn" });
    bindings.delete("root"); notifications.handle(review("child", "child-turn"));
    expect(publish).not.toHaveBeenCalled();
    expect(unroutable).toHaveBeenCalledWith("other-provider", "other-turn", "conflict");
  });

  it("never transfers an old child review to a replacement parent binding", () => {
    const { notifications, bindings, publish } = fixture();
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "turn" });
    bindings.set("root", { ...target, conversationId: "another-chat" });
    notifications.handle(review("child", "child-turn"));
    expect(publish).not.toHaveBeenCalled();
  });

  it("captures the original parent binding before a delayed child Turn establishes exact attribution", () => {
    const { notifications, bindings, publish } = fixture();
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish: vi.fn(), onRunStarted: details => notifications.recordRun(details) });
    try {
      tracker.handleInput({ type: "item.subagentActivity", threadId: "root", turnId: "turn", itemId: "spawn",
        kind: "started", agentThreadId: "child", agentPath: "/root/child" });
      bindings.set("root", { ...target, conversationId: "another-chat" });
      notifications.handle(review("child", "child-turn"));
      tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "child-turn" });
      expect(publish).not.toHaveBeenCalled();
    } finally { tracker.close(); }
  });

  it("preserves healthy Provider runs and pending attribution across another Provider's disconnect", () => {
    const { notifications, providers, publish, unroutable } = fixture();
    for (const thread of ["root", "child", "pending-child"]) providers.set(thread, "healthy");
    providers.set("disconnected-child", "disconnected");
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish: vi.fn(), onRunStarted: details => notifications.recordRun(details) });
    const activity = (agentThreadId: string) => tracker.handleInput({ type: "item.subagentActivity", threadId: "root", turnId: "turn",
      itemId: agentThreadId, kind: "started", agentThreadId, agentPath: `/root/${agentThreadId}` });
    try {
      activity("child");
      tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "child-turn" });
      notifications.handle(review("child", "child-turn", "started"));
      activity("pending-child");
      notifications.handle(review("pending-child", "pending-turn", "started"));
      notifications.handle(review("disconnected-child", "disconnected-turn"));
      notifications.reset("disconnected");
      tracker.resetRunAttribution(threadId => providers.get(threadId) === "disconnected");
      notifications.handle(review("child", "child-turn"));
      tracker.handleInput({ type: "turn.started", threadId: "pending-child", turnId: "pending-turn" });
      notifications.handle(review("pending-child", "pending-turn"));
      expect(publish.mock.calls.map(([event]) => [event.sourceThreadId, event.phase])).toEqual([
        ["child", "started"], ["child", "completed"], ["pending-child", "started"], ["pending-child", "completed"],
      ]);
      expect(unroutable).toHaveBeenCalledWith("disconnected-child", "disconnected-turn", "reset");
      expect(unroutable).not.toHaveBeenCalledWith("pending-child", "pending-turn", "reset");
    } finally { tracker.close(); }
  });

  it("does not replay a failed pending start after the terminal result was published", () => {
    const { notifications, publish } = fixture();
    const delivered: string[] = [];
    publish.mockImplementation(event => {
      if (event.phase === "started") throw new Error("output unavailable");
      delivered.push(event.status);
    });
    notifications.handle(review("root", "turn", "started"));
    notifications.handle(review());
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "turn" });
    expect(delivered).toEqual(["approved"]);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("observes pending expiry and capacity and never marks failed publication as sent", () => {
    vi.useFakeTimers();
    const { notifications, publish, unroutable } = fixture();
    publish.mockImplementationOnce(() => { throw new Error("output unavailable"); });
    notifications.handle(review());
    expect(unroutable).toHaveBeenCalledWith("root", "turn", "publish-failed");
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "turn" });
    expect(publish).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 129; index++) notifications.handle(review(`unknown-${index}`, "unknown-turn"));
    expect(unroutable).toHaveBeenCalledWith("unknown-0", "unknown-turn", "capacity");
    vi.advanceTimersByTime(60_001);
    notifications.recordRun({ agentThreadId: "unknown-1", agentTurnId: "unknown-turn", parentThreadId: "root", parentTurnId: "turn" });
    expect(unroutable).toHaveBeenCalledWith("unknown-1", "unknown-turn", "expired");
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("publishes only the safe projection without action, command or rationale", () => {
    const { notifications, publish } = fixture();
    const projected = toAutoApprovalReviewEvent({ method: "item/autoApprovalReview/completed", params: {
      threadId: "root", turnId: "turn", reviewId: "review", decisionSource: "agent",
      review: { status: "denied", rationale: "secret" }, action: { command: "secret" },
    } });
    expect(projected).toBeDefined(); notifications.handle(projected!);
    expect(publish.mock.calls[0]?.[0].status).toBe("denied");
    expect(JSON.stringify(publish.mock.calls)).not.toContain("secret");
  });
});
