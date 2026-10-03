import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { TurnExecutionTracker, readThreadExecutions } from "../src/bootstrap/turn-execution-tracker.js";
import { CompletionOutputEnricher } from "../src/bootstrap/completion-output-enricher.js";
import type { ThreadTurnSummary, ThreadTurnsPage } from "../src/application/index.js";
import { sample } from "./request-metrics-fixtures.js";

const roots: string[] = [];
const stores: SqliteModelRequestMetricsStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function fixture(options?: { maximumRows?: number }) {
  const root = mkdtempSync(join(tmpdir(), "turn-time-")); roots.push(root);
  const store = new SqliteModelRequestMetricsStore(join(root, "metrics.sqlite3"), undefined, options); stores.push(store);
  return store;
}
const metric = (turnId: string, durationMs: number | null) => ({ turnId, durationMs, recordedAtMs: Date.now() });
const turn = (id: string, durationMs: number | null): ThreadTurnSummary => ({
  id, durationMs, status: "completed", startedAt: null, completedAt: null, inputType: null, textPreview: null,
});
const completed = (turnId: string, durationMs = 71_000) => ({
  type: "turn.completed" as const, threadId: "thread-1", turnId, durationMs, status: "completed" as const, error: null,
});

describe("persisted official turn execution metrics", () => {
  it("does not invalidate committed facts or retry history when refresh notification fails", async () => {
    const store = fixture();
    const listThreadTurns = vi.fn().mockResolvedValue({ turns: [turn("one", 100)], nextCursor: null });
    const errors = vi.fn();
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => { throw new Error("notification unavailable"); }, errors);
    tracker.handle(completed("one", 100), "openai");
    await tracker.settled();
    tracker.handle(completed("two", 200), "openai");
    await tracker.settled();
    expect(store.sessionExecutionDuration("thread-1")).toBe(300);
    expect(listThreadTurns).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalled();
    await tracker.stop();
  });

  it("repairs completeness after retention removes a previously synchronized thread", async () => {
    const store = fixture({ maximumRows: 1 });
    const listThreadTurns = vi.fn().mockResolvedValue({ turns: [turn("one", 100)], nextCursor: null });
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => undefined, () => undefined);
    tracker.handle(completed("one", 100), "openai");
    await tracker.settled();
    // Two writes above plus 98 other facts invoke the real shared retention cleanup.
    for (let index = 0; index < 98; index += 1) store.recordTurnExecution("other", "openai", metric(`other-${index}`, 1));
    expect(store.isExecutionHistoryComplete("thread-1")).toBe(false);
    listThreadTurns.mockResolvedValue({ turns: [turn("two", 200), turn("one", 100)], nextCursor: null });
    tracker.handle(completed("two", 200), "openai");
    await tracker.settled();
    expect(listThreadTurns).toHaveBeenCalledTimes(2);
    expect(store.threadSummary("thread-1").sessionDurationMs).toBe(300);
    await tracker.stop();
  });

  it("invalidates both readers on write failure and repairs without another completion", async () => {
    const store = fixture();
    const listThreadTurns = vi.fn().mockResolvedValue({ turns: [turn("one", 100)], nextCursor: null });
    const notifications: Array<number | null | undefined> = [];
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store,
      () => notifications.push(store.threadSummary("thread-1").sessionDurationMs), () => undefined);
    tracker.handle(completed("one", 100), "openai");
    await tracker.settled();
    const enricher = new CompletionOutputEnricher(pino({ enabled: false }), undefined, {
      executionTiming: (threadId, turnId) => ({ durationMs: store.turnExecutionDuration(threadId, turnId), sessionDurationMs: store.sessionExecutionDuration(threadId, turnId) }),
    });
    const output = { type: "turn.completed" as const, threadId: "thread-1", turnId: "two", durationMs: 200,
      status: "completed" as const, target: { surface: "telegram", accountId: "a", conversationId: "c" } };
    vi.spyOn(store, "recordTurnExecution").mockImplementationOnce(() => { throw new Error("busy"); });
    listThreadTurns.mockRejectedValueOnce(new Error("temporarily offline"))
      .mockResolvedValue({ turns: [turn("two", 200), turn("one", 100)], nextCursor: null });
    tracker.handle(completed("two", 200), "openai");
    expect(store.threadSummary("thread-1").sessionDurationMs).toBeNull();
    await expect(enricher.enrich(output)).resolves.toMatchObject({ durationMs: 200, sessionDurationMs: undefined });
    await tracker.settled();
    expect(store.threadSummary("thread-1")).toMatchObject({ sessionDurationMs: 300, latestExecution: { turnId: "two", durationMs: 200 } });
    await expect(enricher.enrich(output)).resolves.toMatchObject({ durationMs: 200, sessionDurationMs: 300 });
    expect(notifications).toContain(null);
    expect(notifications.at(-1)).toBe(300);
    await tracker.stop();
  });

  it("discards an older in-flight snapshot even when the newer live write fails", async () => {
    const store = fixture();
    let resolvePage!: (page: ThreadTurnsPage) => void;
    const listThreadTurns = vi.fn().mockImplementationOnce(() => new Promise<ThreadTurnsPage>(resolve => { resolvePage = resolve; }))
      .mockResolvedValue({ turns: [turn("two", 200), turn("one", 100)], nextCursor: null });
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => undefined, () => undefined);
    tracker.handle(completed("one", 100), "openai");
    await Promise.resolve();
    vi.spyOn(store, "recordTurnExecution").mockImplementationOnce(() => { throw new Error("busy"); });
    tracker.handle(completed("two", 200), "openai");
    resolvePage({ turns: [turn("one", 100)], nextCursor: null });
    await tracker.settled();
    expect(listThreadTurns).toHaveBeenCalledTimes(2);
    expect(store.threadSummary("thread-1")).toMatchObject({ sessionDurationMs: 300, latestExecution: { turnId: "two", durationMs: 200 } });
    await tracker.stop();
  });

  it("recovers a restored binding without another Turn and isolates disconnected providers", async () => {
    const store = fixture();
    const listThreadTurns = vi.fn().mockResolvedValue({ turns: [turn("one", 100)], nextCursor: null });
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => undefined, () => undefined);
    tracker.synchronize("thread-1", "openai");
    tracker.synchronize("other", "other-provider");
    await tracker.settled();
    tracker.reset("openai");
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
    expect(store.sessionExecutionDuration("other")).toBe(100);
    listThreadTurns.mockResolvedValue({ turns: [turn("two", 200), turn("one", 100)], nextCursor: null });
    tracker.synchronize("thread-1", "openai");
    await tracker.settled();
    expect(store.sessionExecutionDuration("thread-1")).toBe(300);
    await tracker.stop();
  });

  it("retries a lagging authoritative snapshot and cancels retry backoff at shutdown", async () => {
    const store = fixture();
    const listThreadTurns = vi.fn().mockResolvedValueOnce({ turns: [], nextCursor: null })
      .mockResolvedValue({ turns: [turn("one", 100)], nextCursor: null });
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => undefined, () => undefined);
    tracker.handle(completed("one", 100), "openai");
    await tracker.settled();
    expect(store.sessionExecutionDuration("thread-1")).toBe(100);
    listThreadTurns.mockRejectedValue(new Error("offline"));
    tracker.synchronize("thread-1", "openai");
    await Promise.resolve();
    await Promise.resolve();
    await tracker.stop();
    expect(listThreadTurns).toHaveBeenCalledTimes(3);
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
  });

  it("deduplicates live and recovered facts, keeps zero, restores after restart and scopes totals through the card Turn", () => {
    let store = fixture();
    store.recordTurnExecution("thread-1", "openai", metric("one", 0));
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
    store.replaceThreadExecutions("thread-1", "openai", [metric("one", 0), metric("two", 71_000)]);
    store.recordTurnExecution("thread-1", "openai", metric("two", 71_000));
    store.recordTurnExecution("thread-1", "openai", metric("two", null));
    store.replaceThreadExecutions("thread-1", "openai", [metric("one", 0), metric("two", null)]);
    store.recordTurnExecution("thread-1", "openai", metric("three", 2_000));
    store.replaceThreadExecutions("child", "openai", [metric("child-turn", 999_000)]);
    const path = store.path;
    store.close();
    store = new SqliteModelRequestMetricsStore(path, undefined, { readOnly: true }); stores.push(store);
    expect(store.turnExecutionDuration("thread-1", "one")).toBe(0);
    expect(store.sessionExecutionDuration("thread-1", "two")).toBe(71_000);
    expect(store.sessionExecutionDuration("thread-1")).toBe(73_000);
    expect(store.threadSummary("thread-1").latestExecution).toEqual({ turnId: "three", durationMs: 2_000 });
    expect(store.sessionExecutionDuration("thread-1", "absent")).toBeNull();
    expect(() => store.recordTurnExecution("thread-1", "openai", metric("four", 1))).toThrow("只读");
  });

  it("never claims a complete total with missing durations and atomically replaces reverted history", () => {
    const store = fixture();
    store.replaceThreadExecutions("thread-1", "openai", [metric("one", 100), metric("two", null)]);
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
    expect(store.sessionExecutionDuration("thread-1", "one")).toBe(100);
    expect(() => store.replaceThreadExecutions("thread-1", "openai", [metric("one", -1)])).toThrow();
    expect(store.turnExecutionDuration("thread-1", "one")).toBe(100);
    store.invalidateThreadExecutions("thread-1");
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
    expect(store.turnExecutionDuration("thread-1", "one")).toBeNull();
    store.replaceThreadExecutions("thread-1", "openai", [metric("one", 100)]);
    expect(store.sessionExecutionDuration("thread-1")).toBe(100);
    expect(store.turnExecutionDuration("thread-1", "two")).toBeNull();
  });

  it("joins one duration per Turn despite multiple requests and returns the same persisted facts to cards", async () => {
    const store = fixture();
    store.record(sample()); store.record(sample());
    store.replaceThreadExecutions("thread-1", "openai", [metric("turn-1", 71_000)]);
    expect(store.threadSummary("thread-1")).toMatchObject({ sessionDurationMs: 71_000, latestTurn: { durationMs: 71_000, requestCount: 2 } });
    expect(store.threadTurnSummaries("thread-1", { startAtMs: 0, endAtMs: Date.now() + 1, limit: 20 }).turns[0]?.durationMs).toBe(71_000);
    const enricher = new CompletionOutputEnricher(pino({ enabled: false }), undefined, {
      executionTiming: (threadId, turnId) => ({ durationMs: store.turnExecutionDuration(threadId, turnId), sessionDurationMs: store.sessionExecutionDuration(threadId, turnId) }),
    });
    await expect(enricher.enrich({ type: "turn.completed", threadId: "thread-1", turnId: "turn-1", status: "completed",
      target: { surface: "telegram", accountId: "a", conversationId: "c" } }))
      .resolves.toMatchObject({ durationMs: 71_000, sessionDurationMs: 71_000 });
  });

  it("hydrates once, persists subsequent completions without rescanning, and resynchronizes after revert or reconnect", async () => {
    const store = fixture();
    const listThreadTurns = vi.fn().mockResolvedValue({ turns: [turn("two", 71_000), turn("one", 1_000)], nextCursor: null });
    const errors = vi.fn();
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => undefined, errors);
    tracker.handle(completed("two"), "openai");
    await tracker.settled();
    tracker.handle(completed("three", 2_000), "openai");
    expect(listThreadTurns).toHaveBeenCalledTimes(1);
    expect(store.sessionExecutionDuration("thread-1")).toBe(74_000);
    listThreadTurns.mockResolvedValue({ turns: [turn("one", 1_000)], nextCursor: null });
    tracker.handle({ type: "thread.reverted", threadId: "thread-1" }, "openai");
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
    await tracker.settled();
    expect(store.sessionExecutionDuration("thread-1")).toBe(1_000);
    tracker.reset();
    listThreadTurns.mockResolvedValue({ turns: [turn("new", 2_000), turn("one", 1_000)], nextCursor: null });
    tracker.handle(completed("new", 2_000), "openai");
    await tracker.settled();
    expect(listThreadTurns).toHaveBeenCalledTimes(3);
    expect(errors).not.toHaveBeenCalled();
    tracker.stop();
  });

  it("discards in-flight snapshots when a new completion arrives and does not write after shutdown", async () => {
    const store = fixture();
    let resolvePage: (page: ThreadTurnsPage) => void = () => undefined;
    const listThreadTurns = vi.fn().mockImplementationOnce(() => new Promise<ThreadTurnsPage>(resolve => { resolvePage = resolve; }))
      .mockResolvedValue({ turns: [turn("two", 2_000), turn("one", 1_000)], nextCursor: null });
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => undefined, () => undefined);
    tracker.handle(completed("one", 1_000), "openai");
    await Promise.resolve();
    tracker.handle(completed("two", 2_000), "openai");
    resolvePage({ turns: [turn("one", 1_000)], nextCursor: null });
    await tracker.settled();
    expect(store.sessionExecutionDuration("thread-1")).toBe(3_000);
    tracker.reset();
    listThreadTurns.mockImplementation(() => new Promise<ThreadTurnsPage>(resolve => { resolvePage = resolve; }));
    tracker.handle(completed("three", 3_000), "openai");
    await Promise.resolve();
    tracker.stop();
    await tracker.settled();
    resolvePage({ turns: [], nextCursor: null });
    await Promise.resolve();
    expect(store.turnExecutionDuration("thread-1", "three")).toBe(3_000);
  });

  it("limits pages and cancels slow history without losing the live duration", async () => {
    const listThreadTurns = vi.fn(async (): Promise<ThreadTurnsPage> => ({ turns: [], nextCursor: String(listThreadTurns.mock.calls.length) }));
    await expect(readThreadExecutions({ listThreadTurns }, "thread", new AbortController().signal)).rejects.toThrow("分页上限");
    expect(listThreadTurns).toHaveBeenCalledTimes(100);
    const controller = new AbortController();
    const slow = readThreadExecutions({ listThreadTurns: () => new Promise(() => undefined) }, "thread", controller.signal);
    controller.abort();
    await expect(slow).rejects.toThrow("取消或超时");
    const store = fixture();
    const errors = vi.fn();
    const tracker = new TurnExecutionTracker({ listThreadTurns: async () => { throw new Error("offline"); } }, store, () => undefined, errors);
    tracker.handle(completed("one"), "openai");
    await tracker.settled();
    expect(store.turnExecutionDuration("thread-1", "one")).toBe(71_000);
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
    expect(errors).toHaveBeenCalledTimes(3);
    tracker.stop();
  });

  it("keeps live facts when history has not caught up and rejects duplicate pages", async () => {
    const store = fixture();
    const errors = vi.fn();
    const tracker = new TurnExecutionTracker({ listThreadTurns: async () => ({ turns: [], nextCursor: null }) }, store, () => undefined, errors);
    tracker.handle(completed("one"), "openai");
    await tracker.settled();
    expect(store.turnExecutionDuration("thread-1", "one")).toBe(71_000);
    expect(store.sessionExecutionDuration("thread-1")).toBeNull();
    expect(errors).toHaveBeenCalledTimes(3);
    tracker.stop();
    await expect(readThreadExecutions({ listThreadTurns: async () => ({ turns: [turn("one", 1)], nextCursor: "next" }) },
      "thread", new AbortController().signal)).rejects.toThrow("重复轮次");
  });

  it("repairs a missed live write from official history on the next completion", async () => {
    const store = fixture();
    const listThreadTurns = vi.fn().mockResolvedValue({ turns: [turn("one", 1_000)], nextCursor: null });
    const errors = vi.fn();
    const tracker = new TurnExecutionTracker({ listThreadTurns }, store, () => undefined, errors);
    tracker.handle(completed("one", 1_000), "openai");
    await tracker.settled();
    vi.spyOn(store, "recordTurnExecution").mockImplementationOnce(() => { throw new Error("busy"); });
    tracker.handle(completed("two", 2_000), "openai");
    listThreadTurns.mockResolvedValue({ turns: [turn("three", 3_000), turn("two", 2_000), turn("one", 1_000)], nextCursor: null });
    tracker.handle(completed("three", 3_000), "openai");
    await tracker.settled();
    expect(store.sessionExecutionDuration("thread-1")).toBe(6_000);
    expect(listThreadTurns).toHaveBeenCalledTimes(2);
    expect(errors).toHaveBeenCalledOnce();
    tracker.stop();
  });
});
