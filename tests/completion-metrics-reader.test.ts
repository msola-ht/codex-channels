import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const { CompletionMetricsReader } = await import(
  pathToFileURL(join(process.cwd(), "dist/observability/completion-metrics-reader.js")).href
) as typeof import("../src/observability/completion-metrics-reader.js");

describe("completion metrics worker", () => {
  it("reads committed metrics through a separate read-only connection without blocking timers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "completion-metrics-"));
    const path = join(directory, "metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path);
    const reader = new CompletionMetricsReader(path);
    try {
      store.record({ ...sample(), threadId: "thread", turnId: "turn" });
      let timerRan = false;
      const timer = new Promise<void>(resolve => setTimeout(() => { timerRan = true; resolve(); }, 0));
      const result = await reader.query("threadTurnSummary", "thread", "turn");
      expect(timerRan).toBe(true);
      await timer;
      expect(result).toEqual(store.threadTurnSummary("thread", "turn"));
      expect(await reader.query("threadTurnTaskSummary", "thread", "turn"))
        .toEqual(store.threadTurnTaskSummary("thread", "turn"));
      expect(await reader.query("threadSummary", "thread")).toEqual(store.threadSummary("thread"));
    } finally {
      await reader.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds pending queries and rejects them on close", async () => {
    const reader = new CompletionMetricsReader("/missing-metrics.sqlite3");
    const pending = Array.from({ length: 32 }, () => reader.query("threadSummary", "thread"));
    const settled = Promise.allSettled(pending);
    await expect(reader.query("threadSummary", "overflow")).rejects.toThrow("队列已满");
    await reader.close();
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    await expect(reader.query("threadSummary", "closed")).rejects.toThrow("暂不可用");
  });

  it("fails closed for a missing database and cools down instead of restarting repeatedly", async () => {
    const reader = new CompletionMetricsReader("/missing-metrics.sqlite3");
    try {
      await expect(reader.query("threadSummary", "thread")).rejects.toThrow("已停止或超时");
      await expect(reader.query("threadSummary", "thread")).rejects.toThrow("暂不可用");
    } finally { await reader.close(); }
  });
});
