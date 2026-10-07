import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoApprovalReviewNotifications } from "../src/bootstrap/auto-approval-review-notifications.js";
import { SubagentCompletionTracker } from "../src/bootstrap/subagent-completion-tracker.js";
import { toAutoApprovalReviewEvent } from "../src/codex-client/index.js";
import type { AutoApprovalReviewEvent } from "../src/codex-client/index.js";
import type { ConversationTarget } from "../src/conversation-core/index.js";
import { createAutoApprovalReviewPresentation, renderPlainLifecyclePresentation } from "../src/surfaces/lifecycle-presentation.js";

const target = { surface: "telegram", accountId: "default", conversationId: "chat" } as const;
const review = (threadId = "root", turnId = "turn", phase: "started" | "completed" = "completed"): AutoApprovalReviewEvent => ({
  threadId, turnId, reviewId: "review", phase, status: phase === "started" ? "inProgress" : "approved", approved: phase === "completed",
});
function fixture(provider = "fixture") {
  const bindings = new Map<string, ConversationTarget>([["root", target]]);
  const providers = new Map<string, string>();
  const publish = vi.fn();
  const unroutable = vi.fn();
  const notifications = new AutoApprovalReviewNotifications({
    targetForThread: thread => bindings.get(thread), isBackgroundThread: () => false,
    providerForThread: thread => providers.get(thread) ?? provider, publish, unroutable,
  });
  notifications.observeParentRun("root", "turn");
  return { notifications, bindings, providers, publish, unroutable };
}
afterEach(() => vi.useRealTimers());

describe("safe automatic review channel notifications", () => {
  it("routes each completion once and ignores starts before and after completion", () => {
    const { notifications, publish } = fixture();
    notifications.handle(review("root", "turn", "started"));
    notifications.handle(review("root", "turn", "started"));
    notifications.handle(review()); notifications.handle(review());
    notifications.handle(review("root", "turn", "started"));
    expect(publish.mock.calls.map(([event]) => event.status)).toEqual(["approved"]);
    notifications.observeParentRun("root", "other");
    notifications.handle(review("root", "other"));
    notifications.handle(review("root", "other", "started"));
    expect(publish.mock.calls.map(([event]) => event.status)).toEqual(["approved", "approved"]);
    notifications.reset(); notifications.handle(review());
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("routes late recursive run attribution while preserving source and authorized parent identities", () => {
    const { notifications, publish, unroutable } = fixture();
    notifications.handle(review("grandchild", "grand-turn", "started"));
    notifications.handle(review("grandchild", "grand-turn"));
    notifications.recordRun({ agentThreadId: "grandchild", agentTurnId: "grand-turn", parentThreadId: "child", parentTurnId: "child-turn" });
    expect(publish).not.toHaveBeenCalled();
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "turn" });
    expect(publish.mock.calls.map(([event]) => event.phase)).toEqual(["completed"]);
    expect(publish.mock.calls[0]?.[0]).toEqual({ type: "autoApprovalReview.updated", target,
      threadId: "root", turnId: "turn", sourceThreadId: "grandchild", sourceTurnId: "grand-turn",
      reviewId: "review", phase: "completed", status: "approved" });
    notifications.handle(review("child", "unrelated-turn"));
    expect(publish).toHaveBeenCalledOnce();
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

  it("cannot establish ownership from a review when an old Turn gains a new binding", () => {
    const { notifications, bindings, publish, unroutable } = fixture();
    bindings.delete("root");
    notifications.handle(review("root", "unobserved-turn", "started"));
    bindings.set("root", { ...target, conversationId: "another-chat" });
    notifications.handle(review("root", "unobserved-turn"));
    notifications.observeParentRun("root", "unobserved-turn");
    notifications.recordRun({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "root", parentTurnId: "unobserved-turn" });
    notifications.handle(review("child", "child-turn"));
    expect(publish).not.toHaveBeenCalled();
    expect(unroutable).toHaveBeenCalledWith("root", "unobserved-turn", "awaiting-attribution");
    expect(unroutable).toHaveBeenCalledWith("child", "child-turn", "awaiting-attribution");
  });

  it.each(["reset", "capacity"] as const)("cannot recapture a forgotten parent from mid-Turn spawn or followup after %s", reason => {
    const { notifications, bindings, publish, unroutable } = fixture();
    if (reason === "reset") notifications.reset();
    else {
      for (let index = 0; index < 512; index++) notifications.observeParentRun(`other-${index}`, "turn");
      expect(unroutable).toHaveBeenCalledWith("root", "turn", "capacity");
    }
    bindings.set("root", { ...target, conversationId: "another-chat" });
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish: vi.fn(), onRunStarted: details => notifications.recordRun(details) });
    try {
      tracker.handleInput({ type: "item.subagentActivity", threadId: "root", turnId: "turn", itemId: "spawn",
        kind: "started", agentThreadId: "child", agentPath: "/root/child" });
      tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "child-turn" });
      notifications.handle(review("child", "child-turn"));
      tracker.handleInput({ type: "item.operation.updated", threadId: "root", turnId: "turn",
        operation: { itemId: "followup", kind: "subagent", action: "followup_task", status: "completed", receiverThreadIds: ["followup-child"] } });
      tracker.handleInput({ type: "turn.started", threadId: "followup-child", turnId: "followup-turn" });
      notifications.handle(review("followup-child", "followup-turn"));
      expect(publish).not.toHaveBeenCalled();
      expect(unroutable).toHaveBeenCalledWith("child", "child-turn", "awaiting-attribution");
      expect(unroutable).toHaveBeenCalledWith("followup-child", "followup-turn", "awaiting-attribution");
    } finally { tracker.close(); }
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
    const { notifications, providers, publish, unroutable } = fixture("healthy");
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
        ["child", "completed"], ["pending-child", "completed"],
      ]);
      expect(unroutable).toHaveBeenCalledWith("disconnected-child", "disconnected-turn", "reset");
      expect(unroutable).not.toHaveBeenCalledWith("pending-child", "pending-turn", "reset");
    } finally { tracker.close(); }
  });

  it("never attempts to publish starts before the terminal result or later attribution", () => {
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
    expect(publish).toHaveBeenCalledOnce();
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

  it.each([
    [{ type: "command", command: "secret" }, { kind: "command" }, "执行命令"],
    [{ type: "execve", argv: ["secret"] }, { kind: "execve" }, "启动程序"],
    [{ type: "writeStdin", chars: "secret" }, { kind: "writeStdin" }, "向运行中的命令输入内容"],
    [{ type: "mcpToolCall", arguments: { token: "secret" } }, { kind: "mcpToolCall" }, "调用 MCP 工具"],
    [{ type: "requestPermissions", permissions: { filesystem: ["secret"] } }, { kind: "requestPermissions" }, "申请额外权限"],
    [{ type: "applyPatch", files: ["secret", "secret-2"], patch: "secret" }, { kind: "applyPatch", fileCount: 2 }, "修改文件"],
    [{ type: "networkAccess", protocol: "https", port: 443, host: "secret" }, { kind: "networkAccess", protocol: "https", port: 443 }, "访问网络"],
  ] as const)("publishes and renders only safe action and assessment facts for %j", (action, expected, actionLabel) => {
    const { notifications, publish } = fixture();
    const projected = toAutoApprovalReviewEvent({ method: "item/autoApprovalReview/completed", params: {
      threadId: "root", turnId: "turn", reviewId: "review", decisionSource: "agent",
      review: { status: "denied", riskLevel: "high", userAuthorization: "medium", rationale: "secret", summary: "secret" }, action,
    } });
    expect(projected).toBeDefined(); notifications.handle(projected!);
    expect(publish.mock.calls[0]?.[0].status).toBe("denied");
    expect(publish.mock.calls[0]?.[0].details).toEqual({ action: expected, riskLevel: "high", userAuthorization: "medium" });
    const presentation = createAutoApprovalReviewPresentation(publish.mock.calls[0]![0]);
    expect(presentation).not.toBeNull();
    const rendered = renderPlainLifecyclePresentation(presentation!);
    expect(rendered).toContain("自动审批完成");
    expect(rendered).toContain(`审查内容：${actionLabel}`);
    expect(rendered).toContain("风险等级：高");
    expect(rendered).toContain("用户授权评估：中");
    if (action.type === "applyPatch") expect(rendered).toContain("涉及文件：2 个");
    if (action.type === "networkAccess") {
      expect(rendered).toContain("网络协议：HTTPS");
      expect(rendered).toContain("目标端口：443");
    }
    expect(JSON.stringify(publish.mock.calls)).not.toContain("secret");
    expect(rendered).not.toContain("secret");
  });
});
