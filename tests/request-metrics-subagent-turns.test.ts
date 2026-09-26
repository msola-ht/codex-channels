import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics subagent turn attribution", () => {
  it("attributes repeated runs of one subagent Thread to their exact parent Turns", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-subagent-turns-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"));
    store.record({ ...sample(), threadId: "root", turnId: "parent-turn-a", inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    store.record({ ...sample(), threadId: "root", turnId: "parent-turn-b", inputTokens: 200, outputTokens: 20, totalTokens: 220 });
    store.record({ ...sample(), threadId: "child", turnId: "child-turn-a", inputTokens: 300, outputTokens: 30, totalTokens: 330 });
    store.record({ ...sample(), threadId: "child", turnId: "child-turn-b", inputTokens: 400, outputTokens: 40, totalTokens: 440 });
    store.recordSubagentThread({ agentThreadId: "child", parentThreadId: "root", parentTurnId: "parent-turn-a", agentPath: "/root/child" });
    store.recordSubagentTurn({ agentThreadId: "child", agentTurnId: "child-turn-a", parentThreadId: "root", parentTurnId: "parent-turn-a", agentPath: "/root/child" });
    store.recordSubagentTurn({ agentThreadId: "child", agentTurnId: "child-turn-b", parentThreadId: "root", parentTurnId: "parent-turn-b", agentPath: "/root/child" });
    expect(store.threadTurnTaskSummary("root", "parent-turn-a")).toMatchObject({ requestCount: 2, inputTokens: 400, outputTokens: 40 });
    expect(store.threadTurnTaskSummary("root", "parent-turn-b")).toMatchObject({ requestCount: 2, inputTokens: 600, outputTokens: 60 });
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
    let sql: string | undefined;
    try {
      store.threadTurnTaskSummary("root", "parent-turn-a");
      sql = prepare.mock.calls.find(([query]) => query.includes("WITH RECURSIVE task_threads"))?.[0];
    } finally { prepare.mockRestore(); }
    expect(sql).toBeDefined();
    const reader = new DatabaseSync(join(directory, "request-metrics.sqlite3"), { readOnly: true });
    try {
      const plan = reader.prepare(`EXPLAIN QUERY PLAN ${sql!}`).all("root", "parent-turn-a", "parent-turn-a");
      expect(plan.some(row => /SEARCH metric USING INDEX/u.test(String(row.detail))), JSON.stringify(plan)).toBe(true);
      expect(plan.some(row => /SCAN metric\b/u.test(String(row.detail)))).toBe(false);
    } finally { reader.close(); }
    store.close();
  });
});
