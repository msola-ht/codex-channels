import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { RequestMetricsQueryService, SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics subagent session aggregation", () => {
  it("filters main Threads before summary and paging while retaining unfiltered queries and child details", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-main-thread-list-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"), 10_000);
    try {
      store.recordBatch([
        { ...sample(), threadId: "root-a", recordedAtMs: 1000, model: "matching" },
        { ...sample(), threadId: "root-a", turnId: "second", recordedAtMs: 1200, model: "matching" },
        { ...sample(), threadId: "root-b", recordedAtMs: 1500, model: "matching" },
        { ...sample(), threadId: "root-c", recordedAtMs: 1600, model: "excluded" },
        { ...sample(), threadId: "child-a", recordedAtMs: 3000, model: "matching" },
        { ...sample(), threadId: "child-b", recordedAtMs: 3100, model: "matching" },
        { ...sample(), threadId: "nested", recordedAtMs: 3200, model: "matching" },
      ]);
      for (const [agentThreadId, parentThreadId] of [["child-a", "root-a"], ["child-b", "root-a"], ["no-requests", "root-a"], ["nested", "child-a"]] as const) {
        store.recordSubagentThread({ agentThreadId, parentThreadId, parentTurnId: "turn-1", agentPath: `/root/${agentThreadId}` });
      }
      const query = { startAtMs: 0, endAtMs: 5000, model: "matching", limit: 1 };
      const mainQuery = { ...query, mainThreadsOnly: true };
      const page = store.threadList(mainQuery);
      expect(page).toMatchObject({ matchedTotal: 2, turnCount: 3, nextOffset: 1, aggregate: { requestCount: 3, inputTokens: 3000, outputTokens: 300 } });
      expect(page.threads).toMatchObject([{ threadId: "root-b", directSubagentCount: 0 }]);
      const next = store.threadList({ ...mainQuery, offset: 1 });
      expect(next).toMatchObject({ matchedTotal: 2, turnCount: 3, nextOffset: null, aggregate: page.aggregate });
      expect(next.threads).toMatchObject([{ threadId: "root-a", directSubagentCount: 3, requestCount: 2 }]);
      expect(store.threadList({ ...mainQuery, offset: 2 })).toMatchObject({ threads: [], matchedTotal: 2, aggregate: page.aggregate });
      expect(store.threadList(query)).toMatchObject({ matchedTotal: 5, turnCount: 6, threads: [{ threadId: "nested" }], aggregate: { requestCount: 6 } });
      expect(store.threadList({ ...mainQuery, threadId: "child-a" })).toMatchObject({ threads: [], matchedTotal: 0, aggregate: null, turnCount: 0 });
      expect(store.threadTurnSummaries("child-a", { ...mainQuery, threadId: "child-a" })).toMatchObject({ matchedTotal: 1, turns: [{ turnId: "turn-1" }], aggregate: { requestCount: 1 } });
      expect(store.threadSubagents("root-a", { limit: 20 })).toMatchObject({ total: 3 });
      const service = new RequestMetricsQueryService(store);
      expect(service.overview({ name: "all", startAtMs: 0, endAtMs: 5000 })).toMatchObject({ threadCount: 6, turnCount: 7 });
    } finally { store.close(); }
  });

  it("pages registered direct children without requests and counts only each child's direct descendants", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-subagent-list-"));
    directories.push(directory);
    const path = join(directory, "request-metrics.sqlite3");
    const writer = new SqliteModelRequestMetricsStore(path);
    writer.close();
    const raw = new DatabaseSync(path);
    const insert = raw.prepare("INSERT INTO subagent_threads (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms) VALUES (?, ?, ?, ?, ?)");
    for (const [id, parent, turn, time] of [
      ["child-b", "root", "turn-b", 200],
      ["child-a", "root", null, 200],
      ["child-old", "root", "turn-old", 100],
      ["grandchild", "child-a", "nested-turn", 300],
      ["great-grandchild", "grandchild", null, 400],
      ["unrelated", "elsewhere", null, 500],
    ] as const) insert.run(id, parent, turn, `/root/${id}`, time);
    raw.close();
    const store = new SqliteModelRequestMetricsStore(path, Date.now(), { readOnly: true });
    try {
      const service = new RequestMetricsQueryService(store);
      expect(store.count()).toBe(0);
      const emptyMetrics = {
        provider: null, model: null, turnCount: 0, requestCount: 0, inputTokens: 0, outputTokens: 0,
        firstRequestStartedAtMs: null, lastRecordedAtMs: null,
        cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 },
      };
      expect(service.threadSubagents("root", { limit: 2 })).toEqual({
        subagents: [
          { ...emptyMetrics, threadId: "child-a", parentThreadId: "root", parentTurnId: null, agentPath: "/root/child-a", recordedAtMs: 200, directSubagentCount: 1 },
          { ...emptyMetrics, threadId: "child-b", parentThreadId: "root", parentTurnId: "turn-b", agentPath: "/root/child-b", recordedAtMs: 200, directSubagentCount: 0 },
        ], total: 3, offset: 0, limit: 2, nextOffset: 2,
      });
      expect(service.threadSubagents("root", { offset: 2, limit: 2 })).toMatchObject({
        subagents: [{ threadId: "child-old", directSubagentCount: 0 }], total: 3, offset: 2, limit: 2, nextOffset: null,
      });
      expect(service.threadSubagents("child-a", { limit: 20 })).toMatchObject({
        subagents: [{ threadId: "grandchild", directSubagentCount: 1 }], total: 1,
      });
      expect(service.threadSubagents("root", { offset: 9, limit: 2 })).toEqual({ subagents: [], total: 3, offset: 9, limit: 2, nextOffset: null });
      expect(service.threadSubagents("missing", { limit: 20 })).toEqual({ subagents: [], total: 0, offset: 0, limit: 20, nextOffset: null });
      for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: 1, offset: -1 }, { limit: 1, offset: Number.MAX_SAFE_INTEGER + 1 }]) {
        expect(() => service.threadSubagents("root", query)).toThrow();
      }
      expect(() => service.threadSubagents(" ", { limit: 20 })).toThrow("Thread ID");
    } finally { store.close(); }
  });

  it("summarizes each child's retained requests and sorts all children by real request times before paging", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-subagent-metrics-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"), 10_000);
    try {
      store.recordBatch([
        { ...sample(), threadId: "child-a", turnId: "first", provider: "old", model: "old", requestStartedAtMs: 100, recordedAtMs: 100, inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
        { ...sample(), threadId: "child-a", turnId: "second", provider: "middle", model: "middle", requestStartedAtMs: 300, recordedAtMs: 900, inputTokens: 200, cachedInputTokens: null, outputTokens: 20 },
        { ...sample(), threadId: "child-a", turnId: "second", provider: "latest", model: "latest", requestStartedAtMs: 200, recordedAtMs: 200, inputTokens: null, cachedInputTokens: 10, outputTokens: 30 },
        { ...sample(), threadId: "child-b", provider: "other", model: null, requestStartedAtMs: 50, recordedAtMs: 500 },
        { ...sample(), threadId: "child-c", requestStartedAtMs: 80, recordedAtMs: 900 },
        { ...sample(), threadId: "nested", provider: "nested", model: "nested", requestStartedAtMs: 1, recordedAtMs: 1000, inputTokens: 9000, outputTokens: 900 },
      ]);
      for (const [agentThreadId, parentThreadId] of [["child-a", "root"], ["child-b", "root"], ["child-c", "root"], ["no-requests", "root"], ["nested", "child-a"]] as const) {
        store.recordSubagentThread({ agentThreadId, parentThreadId, parentTurnId: "parent", agentPath: `/root/${agentThreadId}` });
      }
      const page = store.threadSubagents("root", { limit: 1 });
      expect(page).toMatchObject({ total: 4, nextOffset: 1, subagents: [{
        threadId: "child-a", provider: "latest", model: "latest", directSubagentCount: 1,
        turnCount: 2, requestCount: 3, inputTokens: 300, outputTokens: 60,
        firstRequestStartedAtMs: 100, lastRecordedAtMs: 900,
        cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 2 },
      }] });
      const ids = (sortKey: "time" | "last", sortDirection: "asc" | "desc") =>
        store.threadSubagents("root", { limit: 10, sortKey, sortDirection }).subagents.map((child) => child.threadId);
      expect(ids("last", "desc")).toEqual(["child-a", "child-c", "child-b", "no-requests"]);
      expect(ids("last", "asc")).toEqual(["child-b", "child-a", "child-c", "no-requests"]);
      expect(ids("time", "asc")).toEqual(["child-b", "child-c", "child-a", "no-requests"]);
      expect(ids("time", "desc")).toEqual(["child-a", "child-c", "child-b", "no-requests"]);
      expect(store.threadSubagents("root", { limit: 1, offset: 1, sortKey: "time", sortDirection: "asc" })).toMatchObject({
        subagents: [{ threadId: "child-c" }], total: 4, nextOffset: 2,
      });
      expect(store.threadSubagents("root", { limit: 10 }).subagents[2]).toMatchObject({ provider: "other", model: null });
      expect(() => store.threadSubagents("root", { limit: 10, sortKey: "requests" as "time" })).toThrow("排序");
      expect(() => store.threadSubagents("root", { limit: 10, sortDirection: "invalid" as "asc" })).toThrow("排序");
    } finally { store.close(); }
  });

  it("reports registered direct child counts independently of the metrics range and filters", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-subagent-count-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"));
    try {
      store.record({ ...sample(), threadId: "root", provider: "matching" });
      store.record({ ...sample(), threadId: "child", provider: "other" });
      store.record({ ...sample(), threadId: "unrelated", provider: "matching" });
      store.recordSubagentThread({ agentThreadId: "child", parentThreadId: "root", parentTurnId: "turn-1", agentPath: "/root/child" });
      store.recordSubagentThread({ agentThreadId: "no-requests", parentThreadId: "root", parentTurnId: "turn-1", agentPath: "/root/no-requests" });
      store.recordSubagentThread({ agentThreadId: "nested", parentThreadId: "child", parentTurnId: "turn-1", agentPath: "/root/child/nested" });
      const page = store.threadList({ startAtMs: 0, endAtMs: Date.now() + 1000, provider: "matching", limit: 20 });
      expect(page.threads.map(({ threadId, directSubagentCount }) => ({ threadId, directSubagentCount }))).toEqual(expect.arrayContaining([
        { threadId: "root", directSubagentCount: 2 }, { threadId: "unrelated", directSubagentCount: 0 },
      ]));
      expect(page.threads).toHaveLength(2);
      const child = store.threadList({ startAtMs: 0, endAtMs: Date.now() + 1000, provider: "other", limit: 1 });
      expect(child.threads[0]).toMatchObject({ threadId: "child", directSubagentCount: 1 });
    } finally { store.close(); }
  });

  it("batches current-page session timing independently of request filters and descendant timing", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-thread-list-timing-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"), 10_000);
    try {
      const now = Date.now();
      for (const threadId of ["complete", "partial", "unsynced", "missing", "unknown"]) {
        store.record({ ...sample(), threadId, provider: "matching", model: "matching", recordedAtMs: now - 1000 });
      }
      store.record({ ...sample(), threadId: "complete", turnId: "outside", provider: "other", model: "other", recordedAtMs: now - 3000 });
      store.recordSubagentThread({ agentThreadId: "child", parentThreadId: "complete", parentTurnId: "outside", agentPath: "/root/child" });
      store.replaceThreadExecutions("complete", "matching", [
        { turnId: "turn-1", durationMs: 100, recordedAtMs: now - 1000 },
        { turnId: "outside", durationMs: 200, recordedAtMs: now - 3000 },
      ]);
      store.replaceThreadExecutions("child", "matching", [{ turnId: "child-turn", durationMs: 9000, recordedAtMs: now - 1000 }]);
      store.replaceThreadExecutions("partial", "matching", [
        { turnId: "turn-1", durationMs: 400, recordedAtMs: now - 1000 },
        { turnId: "missing-turn", durationMs: null, recordedAtMs: now - 1000 },
      ]);
      store.recordTurnExecution("unsynced", "matching", { turnId: "turn-1", durationMs: 500, recordedAtMs: now - 1000 });
      store.replaceThreadExecutions("unknown", "matching", [{ turnId: "turn-1", durationMs: null, recordedAtMs: now - 1000 }]);
      const query = { startAtMs: now - 2000, endAtMs: now, provider: "matching", model: "matching", mainThreadsOnly: true, limit: 10 };
      const page = store.threadList(query);
      expect(page.threads).toHaveLength(5);
      const timings = Object.fromEntries(page.threads.map((thread) => [thread.threadId, thread.sessionTiming]));
      expect(timings).toEqual({
        complete: { knownDurationMs: 300, missingTurnCount: 0, historyComplete: true },
        partial: { knownDurationMs: 400, missingTurnCount: 1, historyComplete: true },
        unsynced: { knownDurationMs: 500, missingTurnCount: 0, historyComplete: false },
        missing: { knownDurationMs: null, missingTurnCount: 0, historyComplete: false },
        unknown: { knownDurationMs: null, missingTurnCount: 1, historyComplete: true },
      });
      for (const thread of page.threads) expect(thread.sessionTiming).toEqual(store.sessionExecutionTiming(thread.threadId));
      const single = store.threadList({ ...query, limit: 1, offset: 2 });
      expect(single.threads).toHaveLength(1);
      expect(single.threads[0]!.sessionTiming).toEqual(timings[single.threads[0]!.threadId]);
    } finally { store.close(); }
  });

  it("recursively includes descendants in the root session aggregate without looping on cycles", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-subagent-"));
    directories.push(directory);
    const path = join(directory, "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);
    store.record({ ...sample(), threadId: "root", turnId: "root-turn", inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    store.record({ ...sample(), threadId: "child", turnId: "child-turn", inputTokens: 200, outputTokens: 20, totalTokens: 220 });
    store.record({ ...sample(), threadId: "grandchild", turnId: "grand-turn", inputTokens: 300, outputTokens: 30, totalTokens: 330 });
    store.record({ ...sample(), threadId: "legacy-child", turnId: "legacy-turn", inputTokens: 400, outputTokens: 40, totalTokens: 440 });
    store.recordSubagentThread({ agentThreadId: "child", parentThreadId: "root", parentTurnId: "root-turn", agentPath: "/root/child" });
    store.recordSubagentThread({ agentThreadId: "grandchild", parentThreadId: "child", parentTurnId: "child-turn", agentPath: "/root/grandchild" });
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO subagent_threads (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms) VALUES (?, ?, NULL, ?, ?)").run("legacy-child", "root", "/root/legacy", Date.now());
    raw.prepare("INSERT INTO subagent_threads (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms) VALUES (?, ?, ?, ?, ?)").run("root", "grandchild", "grand-turn", "/root/cycle", Date.now());
    raw.close();
    expect(store.threadSummary("root").threadAggregate).toMatchObject({ requestCount: 4, inputTokens: 1_000, outputTokens: 100, turnCount: 4 });
    expect(store.threadTurnCount("root")).toBe(1);
    expect(store.threadTurnCount("child")).toBe(1);
    expect(store.aggregate({ dimension: "global", startAtMs: 0, endAtMs: Date.now() + 1_000 }).aggregate).toMatchObject({ requestCount: 4, inputTokens: 1_000, outputTokens: 100 });
    store.close();
  });
});
