import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    store.close();
  });
});
