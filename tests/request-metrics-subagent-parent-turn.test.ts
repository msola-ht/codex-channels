import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

 describe("request metrics subagent parent-turn aggregation", () => {
  it("attributes only explicitly linked child threads to a parent Turn task aggregate", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({ ...sample(), threadId: "root", turnId: "turn-a", inputTokens: 100, outputTokens: 10, totalTokens: 110 });
    store.record({ ...sample(), threadId: "root", turnId: "turn-b", inputTokens: 200, outputTokens: 20, totalTokens: 220 });
    store.record({ ...sample(), threadId: "child-a", turnId: "child-turn", inputTokens: 300, outputTokens: 30, totalTokens: 330 });
    store.record({ ...sample(), threadId: "grandchild", turnId: "grand-turn", inputTokens: 400, outputTokens: 40, totalTokens: 440 });
    store.record({ ...sample(), threadId: "child-b", turnId: "child-b-turn", inputTokens: 500, outputTokens: 50, totalTokens: 550 });
    store.record({ ...sample(), threadId: "legacy-child", turnId: "legacy-turn", inputTokens: 600, outputTokens: 60, totalTokens: 660 });
    store.recordSubagentThread({
      agentThreadId: "child-a",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/a",
    });
    store.recordSubagentTurn({
      agentThreadId: "child-a",
      agentTurnId: "child-turn",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/a",
    });
    store.recordSubagentThread({
      agentThreadId: "grandchild",
      parentThreadId: "child-a",
      parentTurnId: "child-turn",
      agentPath: "/root/grandchild",
    });
    store.recordSubagentTurn({
      agentThreadId: "grandchild",
      agentTurnId: "grand-turn",
      parentThreadId: "child-a",
      parentTurnId: "child-turn",
      agentPath: "/root/grandchild",
    });
    store.recordSubagentThread({
      agentThreadId: "child-b",
      parentThreadId: "root",
      parentTurnId: "turn-b",
      agentPath: "/root/b",
    });
    store.recordSubagentTurn({
      agentThreadId: "child-b",
      agentTurnId: "child-b-turn",
      parentThreadId: "root",
      parentTurnId: "turn-b",
      agentPath: "/root/b",
    });
    const raw = new DatabaseSync(join(directory, "request-metrics.sqlite3"));
    raw.prepare(`
      INSERT INTO subagent_threads
        (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms)
      VALUES (?, ?, NULL, ?, ?)
    `).run("legacy-child", "root", "/root/legacy", Date.now());
    raw.close();

    expect(store.threadTurnTaskSummary("root", "turn-a")).toMatchObject({
      turnId: "turn-a",
      requestCount: 3,
      inputTokens: 800,
      outputTokens: 80,
    });
    expect(store.threadTurnTaskSummary("root", "turn-b")).toMatchObject({
      turnId: "turn-b",
      requestCount: 2,
      inputTokens: 700,
      outputTokens: 70,
    });
    store.close();
  });

  it("keeps a zero task summary when a linked child has no model rows yet", () => {
    const directory = temporaryDirectory();
    const store = new SqliteModelRequestMetricsStore(
      join(directory, "request-metrics.sqlite3"),
    );
    store.record({ ...sample(), threadId: "root", turnId: "turn-a" });
    store.recordSubagentThread({
      agentThreadId: "child",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/child",
    });
    store.recordSubagentTurn({
      agentThreadId: "child",
      agentTurnId: "child-turn",
      parentThreadId: "root",
      parentTurnId: "turn-a",
      agentPath: "/root/child",
    });

    expect(store.threadTurnTaskSummary("root", "turn-a")).toMatchObject({
      turnId: "turn-a",
      requestCount: 1,
      inputTokens: 1_000,
      outputTokens: 100,
    });
    store.recordSubagentThread({
      agentThreadId: "empty-child",
      parentThreadId: "empty-root",
      parentTurnId: "turn-a",
      agentPath: "/root/empty",
    });
    store.recordSubagentTurn({
      agentThreadId: "empty-child",
      agentTurnId: "empty-child-turn",
      parentThreadId: "empty-root",
      parentTurnId: "turn-a",
      agentPath: "/root/empty",
    });
    expect(store.threadTurnTaskSummary("empty-root", "turn-a")).toMatchObject({
      turnId: "turn-a",
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(store.threadTurnTaskSummary("root", "turn-b")).toBeNull();
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-parent-turn-"));
  directories.push(directory);
  return directory;
}
