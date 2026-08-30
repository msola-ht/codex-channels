import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true }); });

describe("request metrics speed coverage", () => {
  it("excludes requests without a matching output window from aggregate speed", () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-speed-"));
    directories.push(directory);
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"));
    store.record(sample());
    store.record({ ...sample(), outputTokens: 200, reasoningOutputTokens: 50, firstOutputDeltaAtMs: null, lastOutputDeltaAtMs: null, requestStartedAtMs: 2_000, responseCompletedAtMs: 2_500 });
    const summary = store.threadSummary("thread-1");
    expect(summary.latestTurn).toMatchObject({ outputSpeedSampleCount: 2, outputSpeedTimedCount: 1 });
    expect(summary.latestTurn?.outputTokensPerSecond).toBeCloseTo(60 / 0.2);
    expect(summary.threadAggregate).toMatchObject({ turnCount: 1, outputSpeedSampleCount: 2, outputSpeedTimedCount: 1 });
    expect(summary.threadAggregate?.outputTokensPerSecond).toBeCloseTo(60 / 0.2);
    store.close();
  });
});
