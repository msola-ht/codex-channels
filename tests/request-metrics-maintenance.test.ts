import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("request metrics maintenance and query boundaries", () => {
  it("removes records older than a custom retention when reopened", () => {
    vi.useFakeTimers();
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const first = new SqliteModelRequestMetricsStore(path);
    first.record(sample());
    first.close();
    vi.setSystemTime(new Date("2026-04-02T00:00:00.001Z"));
    const reopened = new SqliteModelRequestMetricsStore(path, undefined, { retentionDays: 90 });
    expect(reopened.count()).toBe(0);
    reopened.close();
  });

  it("keeps only a custom maximum number of rows when reopened", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const first = new SqliteModelRequestMetricsStore(path);
    first.record(sample());
    first.record({ ...sample(), threadId: "thread-2", turnId: "turn-2" });
    first.close();
    const reopened = new SqliteModelRequestMetricsStore(path, undefined, { maximumRows: 1 });
    expect(reopened.count()).toBe(1);
    reopened.close();
  });

  it("bounds internal reads independently from future presentation APIs", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "request-metrics.sqlite3"));
    expect(() => store.recent(0)).toThrow(/1 到 500/u);
    expect(() => store.recent(501)).toThrow(/1 到 500/u);
    store.close();
  });

  it("opens the live database read-only and pages sanitized records", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const writer = new SqliteModelRequestMetricsStore(path);
    writer.record(sample());
    writer.record({ ...sample(), requestStartedAtMs: 2_000, responseCompletedAtMs: 2_650 });
    const reader = new SqliteModelRequestMetricsStore(path, Date.now(), { readOnly: true });
    const first = reader.page({ startAtMs: 0, endAtMs: Date.now() + 1, limit: 1, sortDirection: "asc" });
    expect(first.records).toHaveLength(1);
    expect(first.nextOffset).toBe(1);
    const second = reader.page({ startAtMs: 0, endAtMs: Date.now() + 1, offset: first.nextOffset ?? 0, limit: 1, sortDirection: "asc" });
    expect(second.records).toHaveLength(1);
    expect(second.records[0]?.id).not.toBe(first.records[0]?.id);
    expect(second.nextOffset).toBeNull();
    expect(() => reader.record(sample())).toThrow(/只读/u);
    reader.close();
    writer.close();
  });

  it("filters request pages across the whole range", () => {
    const store = new SqliteModelRequestMetricsStore(join(temporaryDirectory(), "request-metrics.sqlite3"));
    store.record({ ...sample(), provider: "openai", model: "gpt-5.6-sol", status: "failed", errorType: "usage_limit_reached", errorMessage: "You've hit your usage limit" });
    store.record({ ...sample(), provider: "deepseek", model: "deepseek-v4-flash", status: "completed" });
    store.record({ ...sample(), provider: "openai", model: "gpt-5.6-sol", status: "completed" });
    const range = { startAtMs: 0, endAtMs: Date.now() + 1, limit: 10 };
    expect(store.page({ ...range, filter: "usage limit" })).toMatchObject({ matchedTotal: 1, records: [expect.objectContaining({ errorType: "usage_limit_reached" })] });
    expect(store.page({ ...range, filter: "deepseek" }).records[0]?.provider).toBe("deepseek");
    expect(store.page({ ...range, filter: "%" }).matchedTotal).toBe(0);
    expect(() => store.page({ ...range, filter: "x".repeat(129) })).toThrow(/最多 128/u);
    store.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-maintenance-"));
  temporaryDirectories.push(directory);
  return directory;
}
