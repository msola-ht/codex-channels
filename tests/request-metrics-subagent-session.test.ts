import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics subagent session aggregation", () => {
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
