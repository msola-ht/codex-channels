import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { AutoApprovalReviewTracker } from "../src/bootstrap/auto-approval-review-tracker.js";
import { AutoApprovalReviewNotifications } from "../src/bootstrap/auto-approval-review-notifications.js";
import { SubagentCompletionTracker } from "../src/bootstrap/subagent-completion-tracker.js";
import { toAutoApprovalReviewEvent } from "../src/codex-client/index.js";
import { CompletionOutputEnricher } from "../src/bootstrap/completion-output-enricher.js";
import type { Logger } from "pino";

const directories: string[] = [];
const stores: SqliteModelRequestMetricsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture(maximumRows?: number) {
  const directory = mkdtempSync(join(tmpdir(), "codexc-auto-review-"));
  directories.push(directory);
  const path = join(directory, "metrics.sqlite3");
  const store = new SqliteModelRequestMetricsStore(path, Date.now(), { ...(maximumRows ? { maximumRows } : {}) });
  stores.push(store);
  return { store, path };
}
function closedTurn(store: SqliteModelRequestMetricsStore, threadId: string, turnId: string) {
  store.observeAutoApprovalTurn(threadId, turnId, "openai", "started");
  store.observeAutoApprovalTurn(threadId, turnId, "openai", "completed");
}
function approved(store: SqliteModelRequestMetricsStore, threadId: string, turnId: string, reviewId = "review") {
  store.recordAutoApprovalReview({ threadId, turnId, reviewId, phase: "completed", status: "approved" }, "openai");
}
function counts(approved: number, coverage: "complete" | "partial" | "unknown") {
  return { approved, denied: 0, timedOut: 0, aborted: 0, inProgress: 0, unknown: 0, total: approved, coverage };
}
function link(store: SqliteModelRequestMetricsStore, parentThreadId: string, parentTurnId: string, agentThreadId: string, agentTurnId: string) {
  store.recordSubagentTurn({ parentThreadId, parentTurnId, agentThreadId, agentTurnId, agentPath: "/root/agent" });
}

describe("automatic approval review metrics", () => {
  it("persists distinct terminal results and separates task from session totals", () => {
    const { store, path } = fixture();
    expect(store.sessionAutoApprovalReviewSummary("empty")).toEqual(counts(0, "unknown"));
    for (const [threadId, turnId] of [["root", "old"], ["root", "now"], ["child", "one"], ["child", "other"]]) {
      closedTurn(store, threadId!, turnId!);
    }
    approved(store, "root", "old");
    link(store, "root", "now", "child", "one");
    for (const status of ["approved", "denied", "timedOut", "aborted"] as const) {
      store.recordAutoApprovalReview({ threadId: "child", turnId: "one", reviewId: status, phase: "completed", status }, "openai");
      store.recordAutoApprovalReview({ threadId: "child", turnId: "one", reviewId: status, phase: "completed", status }, "openai");
    }
    approved(store, "child", "other");
    const task = { approved: 1, denied: 1, timedOut: 1, aborted: 1, inProgress: 0, unknown: 0, total: 4, coverage: "complete" };
    expect(store.taskAutoApprovalReviewSummary("root", "now")).toEqual(task);
    expect(store.sessionAutoApprovalReviewSummary("root")).toEqual({ ...task, approved: 2, total: 5 });
    store.recordAutoApprovalReview({ threadId: "child", turnId: "one", reviewId: "denied", phase: "completed", status: "approved" }, "openai");
    expect(store.taskAutoApprovalReviewSummary("root", "now")).toEqual(task);
    store.recordAutoApprovalReview({ threadId: "root", turnId: "now", reviewId: "pending", phase: "started", status: "inProgress" }, "openai");
    const database = new DatabaseSync(path);
    database.prepare(`INSERT INTO auto_approval_reviews
      (thread_id, turn_id, review_id, completed, approved, status, recorded_at_ms)
      VALUES ('root', 'old', 'legacy', 1, 0, 'unknown', ?)`).run(Date.now());
    database.close();
    expect(store.sessionAutoApprovalReviewSummary("root")).toEqual({ ...task, approved: 2, inProgress: 1, unknown: 1, total: 7, coverage: "partial" });
    expect(store.taskAutoApprovalReviewSummary("root", "now")).toEqual({ ...task, inProgress: 1, total: 5, coverage: "partial" });
    store.close();
    const reopened = new SqliteModelRequestMetricsStore(path); stores.push(reopened);
    expect(reopened.sessionAutoApprovalReviewSummary("root")).toEqual({ ...task, approved: 2, inProgress: 1, unknown: 1, total: 7, coverage: "partial" });
  });

  it("deduplicates reviews, keeps starts pending and preserves approvals across restart and readonly access", () => {
    const { store, path } = fixture();
    expect(store.taskAutoApprovalReviewSummary("root", "turn")).toEqual(counts(0, "unknown"));
    closedTurn(store, "root", "turn");
    expect(store.taskAutoApprovalReviewSummary("root", "turn")).toEqual(counts(0, "complete"));
    store.recordAutoApprovalReview({ threadId: "root", turnId: "turn", reviewId: "review", phase: "started", status: "inProgress" }, "openai");
    expect(store.taskAutoApprovalReviewSummary("root", "turn").coverage).toBe("partial");
    approved(store, "root", "turn"); approved(store, "root", "turn");
    store.recordAutoApprovalReview({ threadId: "root", turnId: "turn", reviewId: "review", phase: "started", status: "inProgress" }, "openai");
    expect(store.taskAutoApprovalReviewSummary("root", "turn")).toEqual(counts(1, "complete"));
    store.close();
    const reader = new SqliteModelRequestMetricsStore(path, Date.now(), { readOnly: true }); stores.push(reader);
    expect(reader.taskAutoApprovalReviewSummary("root", "turn").coverage).toBe("complete");
    expect(() => approved(reader, "root", "turn")).toThrow(/只读/u); reader.close();
    const reopened = new SqliteModelRequestMetricsStore(path); stores.push(reopened);
    expect(reopened.taskAutoApprovalReviewSummary("root", "turn")).toEqual(counts(1, "partial"));
  });

  it("recursively includes late exact mappings, cycles and reused Threads without crossing parent Turns", () => {
    const { store } = fixture();
    for (const [thread, turn] of [["root", "a"], ["root", "b"], ["child", "c1"], ["child", "c2"], ["grand", "g"]] as const) {
      closedTurn(store, thread, turn); approved(store, thread, turn);
    }
    link(store, "root", "a", "child", "c1"); link(store, "root", "b", "child", "c2");
    link(store, "child", "c1", "grand", "g"); link(store, "grand", "g", "root", "a");
    expect(store.taskAutoApprovalReviewSummary("root", "a")).toEqual(counts(3, "complete"));
    expect(store.taskAutoApprovalReviewSummary("root", "b")).toEqual(counts(2, "complete"));
    expect(store.taskAutoApprovalReviewSummary("root", "a", [{ threadId: "child", turnId: "c1" }]).coverage).toBe("partial");
    expect(store.taskAutoApprovalReviewSummary("root", "a", [{ threadId: "root", turnId: "b" }]).coverage).toBe("complete");
    link(store, "child", "c1", "running", "run");
    expect(store.taskAutoApprovalReviewSummary("root", "a").coverage).toBe("partial");
    approved(store, "child", "c1", "late-review");
    expect(store.taskAutoApprovalReviewSummary("root", "a").approved).toBe(4);
    expect(store.taskAutoApprovalReviewSummary("root", "b").approved).toBe(2);
  });

  it("degrades missing starts, disconnects and write failures without losing known approvals", () => {
    const { store } = fixture(); approved(store, "unobserved", "turn");
    expect(store.taskAutoApprovalReviewSummary("unobserved", "turn")).toEqual(counts(1, "partial"));
    closedTurn(store, "root", "turn");
    const failed = vi.fn(); const tracker = new AutoApprovalReviewTracker(store, () => "openai", failed);
    const publish = vi.fn();
    const notifications = new AutoApprovalReviewNotifications({ targetForThread: () => ({ surface: "telegram", accountId: "default", conversationId: "chat" }),
      providerForThread: () => "openai", isBackgroundThread: () => false, publish, unroutable: vi.fn() });
    const write = vi.spyOn(store, "recordAutoApprovalReview").mockImplementationOnce(() => { throw new Error("unavailable"); });
    const notification = { method: "item/autoApprovalReview/completed", params: {
      threadId: "root", turnId: "turn", reviewId: "failure", decisionSource: "agent", review: { status: "approved" },
    } };
    tracker.handleNotification(notification);
    notifications.handle(toAutoApprovalReviewEvent(notification)!);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ status: "approved" }));
    expect(failed).toHaveBeenCalledOnce(); write.mockRestore();
    closedTurn(store, "new", "turn"); expect(tracker.summary("new", "turn").coverage).toBe("partial");
    tracker.reset("openai"); expect(store.taskAutoApprovalReviewSummary("root", "turn").coverage).toBe("partial");
  });

  it("persists attribution loss for readonly queries and treats missing Provider ownership as incomplete", () => {
    const { store, path } = fixture(); closedTurn(store, "root", "turn"); approved(store, "root", "turn");
    const tracker = new AutoApprovalReviewTracker(store, () => undefined, vi.fn());
    tracker.handleNotification({ method: "item/autoApprovalReview/completed", params: {
      threadId: "root", turnId: "turn", reviewId: "unknown-provider", decisionSource: "agent", review: { status: "approved" },
    } });
    const reader = new SqliteModelRequestMetricsStore(path, Date.now(), { readOnly: true }); stores.push(reader);
    expect(reader.taskAutoApprovalReviewSummary("root", "turn")).toEqual(counts(1, "partial"));
  });

  it("attributes unbound grandchildren and reused child runs with both arrival orders", () => {
    const { store } = fixture();
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish: vi.fn(), onRunStarted: details => store.recordSubagentTurn(details) });
    const activity = (threadId: string, turnId: string, agentThreadId: string, itemId: string) => tracker.handleInput({
      type: "item.subagentActivity", threadId, turnId, agentThreadId, itemId, agentPath: "/root/agent", kind: "started",
    });
    const start = (threadId: string, turnId: string) => tracker.handleInput({ type: "turn.started", threadId, turnId });
    closedTurn(store, "root", "a"); closedTurn(store, "child", "c1"); closedTurn(store, "grand", "g"); approved(store, "grand", "g");
    start("child", "c1"); activity("root", "a", "child", "activity1");
    activity("child", "c1", "grand", "activity2"); start("grand", "g");
    expect(store.taskAutoApprovalReviewSummary("root", "a").approved).toBe(1);
    closedTurn(store, "root", "b"); closedTurn(store, "child", "c2"); approved(store, "child", "c2");
    activity("root", "b", "child", "activity3"); start("child", "c2");
    expect(store.taskAutoApprovalReviewSummary("root", "b").approved).toBe(1);
    expect(store.taskAutoApprovalReviewSummary("root", "a").approved).toBe(1); tracker.close();
  });

  it("invalidates coverage when retention trims reviews or descendant relations", () => {
    const { store, path } = fixture(1); closedTurn(store, "root", "a");
    approved(store, "root", "a", "old"); approved(store, "root", "a", "new"); link(store, "root", "a", "child", "c");
    const database = new DatabaseSync(path); database.exec("UPDATE subagent_turns SET recorded_at_ms = 0"); database.close();
    for (let index = 0; index < 100; index++) store.observeAutoApprovalTurn("root", "a", "openai", "completed");
    expect(store.taskAutoApprovalReviewSummary("root", "a")).toEqual(counts(1, "partial"));
  });

  it("attributes only explicit followup tasks and never message-only interactions", () => {
    const onRunStarted = vi.fn(); const onRunAttributionIncomplete = vi.fn();
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish: vi.fn(), onRunStarted, onRunAttributionIncomplete });
    const contact = { type: "item.subagentActivity" as const, threadId: "parent", turnId: "a", agentThreadId: "child",
      agentPath: "/root/child", itemId: "message", kind: "interacted" as const };
    tracker.handleInput(contact);
    tracker.handleInput({ type: "item.operation.updated", threadId: "parent", turnId: "a",
      operation: { itemId: "followup", kind: "subagent", action: "followup_task", status: "running" } });
    tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "child-a" });
    expect(onRunStarted).not.toHaveBeenCalled();
    tracker.handleInput({ type: "item.operation.updated", threadId: "parent", turnId: "a",
      operation: { itemId: "followup", kind: "subagent", action: "followup_task", status: "completed", receiverThreadIds: ["child"] } });
    expect(onRunStarted).toHaveBeenCalledWith({ parentThreadId: "parent", parentTurnId: "a",
      agentThreadId: "child", agentTurnId: "child-a", agentPath: "/root/child" });
    tracker.handleInput({ ...contact, itemId: "message2", turnId: "b" });
    tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "child-b" });
    expect(onRunStarted).toHaveBeenCalledOnce();
    tracker.handleInput({ type: "item.subagentActivity", threadId: "parent", turnId: "c", agentThreadId: "missing",
      agentPath: "/root/missing", itemId: "start", kind: "started" });
    tracker.handleInput({ type: "item.subagentActivity", threadId: "parent", turnId: "c", agentThreadId: "missing",
      agentPath: "/root/missing", itemId: "complete", kind: "completed" });
    expect(onRunAttributionIncomplete).toHaveBeenCalledOnce();
    tracker.close();
  });

  it("keeps an old unassigned terminal out of a later followup parent", () => {
    const onRunStarted = vi.fn();
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }), publish: vi.fn(), onRunStarted });
    tracker.handleInput({ type: "turn.completed", threadId: "child", turnId: "old", status: "completed", error: null });
    tracker.handleInput({ type: "item.operation.updated", threadId: "parent", turnId: "new",
      operation: { itemId: "followup", kind: "subagent", action: "followup_task", status: "running" } });
    tracker.handleInput({ type: "item.subagentActivity", threadId: "parent", turnId: "new", agentThreadId: "child",
      agentPath: "/root/child", itemId: "contact", kind: "interacted" });
    tracker.handleInput({ type: "item.operation.updated", threadId: "parent", turnId: "new",
      operation: { itemId: "followup", kind: "subagent", action: "followup_task", status: "completed", receiverThreadIds: ["child"] } });
    expect(onRunStarted).not.toHaveBeenCalled();
    tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "new-child" });
    expect(onRunStarted).toHaveBeenCalledWith({ parentThreadId: "parent", parentTurnId: "new", agentThreadId: "child",
      agentTurnId: "new-child", agentPath: "/root/child" }); tracker.close();
  });

  it("does not infer a followup run from contacted output or missing operation starts", () => {
    const onRunStarted = vi.fn();
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }), publish: vi.fn(), onRunStarted });
    tracker.handle({ type: "subagent.contacted", target: { surface: "test", accountId: "a", conversationId: "c" },
      threadId: "parent", turnId: "new", agentThreadId: "child", agentPath: "/root/child" });
    tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "unrelated" });
    expect(onRunStarted).not.toHaveBeenCalled();
    tracker.handleInput({ type: "item.operation.updated", threadId: "parent", turnId: "new",
      operation: { itemId: "followup", kind: "subagent", action: "followup_task", status: "completed", receiverThreadIds: ["child"] } });
    tracker.handleInput({ type: "turn.completed", threadId: "child", turnId: "old", status: "completed", error: null });
    expect(onRunStarted).not.toHaveBeenCalled(); tracker.close();
  });

  it.each(["approved", "denied", "timedOut", "aborted"])("projects %s without sensitive payloads or unsupported sources", status => {
    const params = { threadId: "root", turnId: "turn", reviewId: "review", decisionSource: "agent",
      review: { status, rationale: "private" }, action: { command: "private" } };
    expect(toAutoApprovalReviewEvent({ method: "item/autoApprovalReview/completed", params })).toEqual({
      threadId: "root", turnId: "turn", reviewId: "review", phase: "completed", status, approved: status === "approved",
    });
    expect(toAutoApprovalReviewEvent({ method: "item/autoApprovalReview/completed", params: { ...params, decisionSource: "user" } })).toBeUndefined();
  });

  it("drops pending run correlation across disconnections and bounded-cache eviction", () => {
    const onRunStarted = vi.fn(); const onRunAttributionIncomplete = vi.fn();
    const tracker = new SubagentCompletionTracker({ readSummary: () => ({ latestTurn: null, threadAggregate: null }),
      publish: vi.fn(), onRunStarted, onRunAttributionIncomplete });
    const activity = (agentThreadId: string) => tracker.handleInput({ type: "item.subagentActivity", threadId: "parent", turnId: "turn",
      agentThreadId, agentPath: "/root/child", itemId: agentThreadId, kind: "started" });
    activity("child"); tracker.resetRunAttribution();
    tracker.handleInput({ type: "turn.started", threadId: "child", turnId: "after-gap" });
    expect(onRunStarted).not.toHaveBeenCalled();
    for (let index = 0; index < 129; index++) activity(`agent-${index}`);
    expect(onRunAttributionIncomplete).toHaveBeenCalled();
    tracker.handleInput({ type: "turn.started", threadId: "agent-0", turnId: "evicted" });
    expect(onRunStarted).not.toHaveBeenCalled(); tracker.close();
  });

  it("enriches completion snapshots and exposes query failures as unknown", async () => {
    const warn = vi.fn(); const logger = { warn } as unknown as Logger;
    const event = { type: "turn.completed" as const, target: { surface: "test", accountId: "a", conversationId: "c" },
      threadId: "root", turnId: "turn", status: "completed" as const };
    const enricher = new CompletionOutputEnricher(logger, undefined, { autoApprovalReview: () => counts(2, "partial") });
    expect(await enricher.enrich(event)).toMatchObject({ autoApprovalReview: { approved: 2, coverage: "partial" } });
    const broken = new CompletionOutputEnricher(logger, undefined, { autoApprovalReview: () => { throw new Error("unavailable"); } });
    expect(await broken.enrich(event)).toMatchObject({ autoApprovalReview: { approved: 0, coverage: "unknown" } });
    expect(warn).toHaveBeenCalledOnce();
  });
});
