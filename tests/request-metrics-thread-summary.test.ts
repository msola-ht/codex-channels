import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics Thread summary", () => {
  it("separates the latest Turn aggregate from the whole Thread aggregate", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-thread-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"));
    store.record(sample());
    store.record({ ...sample(), turnId: "turn-2", requestStartedAtMs: 2_000, firstTokenAtMs: 2_100, firstReasoningDeltaAtMs: 2_100, lastReasoningDeltaAtMs: 2_300, firstOutputDeltaAtMs: 2_400, lastOutputDeltaAtMs: 2_600, responseCompletedAtMs: 2_650 });
    const summary = store.threadSummary("thread-1");
    expect(summary.latestTurn).toMatchObject({ turnId: "turn-2", requestCount: 1 });
    expect(summary.threadAggregate).toMatchObject({ turnCount: 2, requestCount: 2 });
    expect(store.threadTurnSummary("thread-1", "turn-1")).toMatchObject({ turnId: "turn-1", requestCount: 1 });
    expect(store.threadTurnSummary("thread-1", "turn-2")).toMatchObject({ turnId: "turn-2", requestCount: 1 });
    expect(store.threadTurnSummary("thread-1", "missing")).toBeNull();
    store.close();
  });
});
