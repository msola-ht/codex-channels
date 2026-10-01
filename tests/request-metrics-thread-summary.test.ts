import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics Thread summary", () => {
  it("sums exact OpenAI usage by turn and recursive session without mixing providers or counting missing amounts as zero", () => {
    const directory = mkdtempSync(join(tmpdir(), "credits-")); directories.push(directory);
    const path = join(directory, "metrics.sqlite3");
    let store = new SqliteModelRequestMetricsStore(path);
    const record = (turnId: string, responseUsageAmount: string | null, extra = {}) => store.record({
      ...sample(), provider: "openai", turnId, responseUsageAmount, ...extra,
    });
    record("first", "0.1");
    record("first", "0.20000000000000000001", { operation: "compact" });
    record("first", null, { status: "failed" });
    record("second", "0");
    record("second", "99", { provider: "deepseek" });
    record("child-turn", "0.4", { threadId: "child" });
    record("grandchild-turn", "0.5", { threadId: "grandchild" });
    record("unrelated-turn", "1000", { threadId: "unrelated" });
    store.recordSubagentThread({ agentThreadId: "child", parentThreadId: "thread-1", parentTurnId: "first", agentPath: "/root/child" });
    store.recordSubagentThread({ agentThreadId: "grandchild", parentThreadId: "child", parentTurnId: "child-turn", agentPath: "/root/child/grandchild" });
    store.recordSubagentTurn({ agentThreadId: "child", agentTurnId: "child-turn", parentThreadId: "thread-1", parentTurnId: "first", agentPath: "/root/child" });
    store.recordSubagentTurn({ agentThreadId: "grandchild", agentTurnId: "grandchild-turn", parentThreadId: "child", parentTurnId: "child-turn", agentPath: "/root/child/grandchild" });
    store.close();
    store = new SqliteModelRequestMetricsStore(path);
    try {
      expect(store.threadTurnSummary("thread-1", "first")?.responseUsage).toEqual({
        amount: "0.30000000000000000001", observedRequestCount: 2, missingRequestCount: 1,
      });
      expect(store.threadTurnSummary("thread-1", "second")?.responseUsage).toEqual({ amount: "0", observedRequestCount: 1, missingRequestCount: 0 });
      expect(store.threadSummary("thread-1").threadAggregate?.responseUsage).toEqual({
        amount: "1.20000000000000000001", observedRequestCount: 5, missingRequestCount: 1,
      });
      expect(store.threadTurnTaskSummary("thread-1", "first")?.responseUsage).toEqual({
        amount: "1.20000000000000000001", observedRequestCount: 4, missingRequestCount: 1,
      });
      expect(store.threadTurnTaskSummary("thread-1", "second")).toBeNull();
      record("unknown", null);
      expect(store.threadTurnSummary("thread-1", "unknown")?.responseUsage).toEqual({ amount: null, observedRequestCount: 0, missingRequestCount: 1 });
      record("third-party", "25", { provider: "deepseek" });
      expect(store.threadTurnSummary("thread-1", "third-party")?.responseUsage).toBeNull();
    } finally { store.close(); }
  });
  it("separates the latest Turn aggregate from the whole Thread aggregate", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-thread-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"));
    store.record(sample());
    store.record({ ...sample(), turnId: "turn-2", requestStartedAtMs: 2_000, responseCompletedAtMs: 2_650 });
    const summary = store.threadSummary("thread-1");
    expect(summary.latestTurn).toMatchObject({ turnId: "turn-2", requestCount: 1 });
    expect(summary.threadAggregate).toMatchObject({ turnCount: 2, requestCount: 2 });
    expect(store.threadTurnSummary("thread-1", "turn-1")).toMatchObject({ turnId: "turn-1", requestCount: 1 });
    expect(store.threadTurnSummary("thread-1", "turn-2")).toMatchObject({ turnId: "turn-2", requestCount: 1 });
    expect(store.threadTurnSummary("thread-1", "missing")).toBeNull();
    store.close();
  });
});
