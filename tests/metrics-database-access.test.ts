import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectMetricsDatabase,
  metricsRange,
  readMetricsExport,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  upgradeMetricsDatabase,
  validateMetricsDatabaseStructure,
} from "../scripts/metrics-database.mjs";
import {
  modelRequestMetricsSchemaVersion,
  SqliteModelRequestMetricsStore,
} from "../src/observability/index.js";
import {
  cleanupMetricsDatabaseTestFixtures,
  createMetricsDatabase,
  createMetricsDatabaseTestFixture,
  metricSample,
} from "./metrics-database-test-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  cleanupMetricsDatabaseTestFixtures(temporaryDirectories);
});

function fixture() {
  return createMetricsDatabaseTestFixture(temporaryDirectories);
}

describe("model request metrics database access", () => {
  it("resolves rolling and local calendar ranges", () => {
    const now = new Date(2026, 7, 9, 11, 30).getTime();
    expect(metricsRange("yesterday", now)).toEqual({
      name: "yesterday",
      startAtMs: new Date(2026, 7, 8).getTime(),
      endAtMs: new Date(2026, 7, 9).getTime(),
    });
    expect(metricsRange("this-month", now).startAtMs)
      .toBe(new Date(2026, 7, 1).getTime());
    expect(metricsRange("90d", now).startAtMs).toBe(now - 90 * 86_400_000);
    expect(metricsRange("all", now)).toEqual({ name: "all", startAtMs: 0, endAtMs: now });
  });

  it("reports a missing database without creating it", () => {
    const { environment, databasePath } = fixture();

    expect(inspectMetricsDatabase(environment)).toEqual({
      compatible: false,
      count: null,
      databasePath,
      exists: false,
      schemaVersion: null,
    });
    expect(existsSync(databasePath)).toBe(false);
  });

  it("reports the current schema and record count read-only", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, modelRequestMetricsSchemaVersion, 2);

    expect(inspectMetricsDatabase(environment)).toEqual({
      compatible: true,
      count: 2,
      databasePath,
      exists: true,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
  });

  it("rejects an upgradeable version whose required structure is incomplete", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, 3, 1);

    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).toThrow(/Schema 3 结构不完整/u);
  });

  it("rejects a current version whose required structure is incomplete", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, modelRequestMetricsSchemaVersion, 1);

    expect(() => validateMetricsDatabaseStructure(environment)).toThrow(
      new RegExp(`Schema ${modelRequestMetricsSchemaVersion} 结构不完整`, "u"),
    );
  });

  it("rejects a current version with legacy columns", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.close();
    const database = new DatabaseSync(databasePath);
    database.exec("ALTER TABLE model_request_metrics ADD COLUMN billing_mode TEXT;");
    database.close();

    expect(() => validateMetricsDatabaseStructure(environment)).toThrow(
      new RegExp(`Schema ${modelRequestMetricsSchemaVersion} 结构不完整`, "u"),
    );
    expect(() => upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
    })).toThrow(
      new RegExp(`Schema ${modelRequestMetricsSchemaVersion} 结构不完整`, "u"),
    );
    expect(() => {
      const opened = new SqliteModelRequestMetricsStore(databasePath);
      opened.close();
    }).toThrow(
      new RegExp(`Schema ${modelRequestMetricsSchemaVersion} 结构不完整`, "u"),
    );
  });

  it("reads a reusable aggregate report and paged sanitized export", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({
      ...metricSample(),
      provider: "openai",
      weeklyQuota: {
        limitId: "codex",
        planType: "plus",
        usedPercentMillionths: 12_500_000,
        resetsAt: Math.floor(Date.now() / 1_000) + 24 * 60 * 60,
      },
    });
    store.record({
      ...metricSample(),
      responseFormat: "unknown",
      model: null,
      status: "completed",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
    store.close();
    const nowMs = Date.now() + 1;

    const report = readMetricsReport(environment, {
      range: "24h",
      group: "models",
      nowMs,
    });
    expect(report).toMatchObject({
      format: "codex-connect-request-metrics-report",
      version: 3,
      weeklyQuota: {
        limitId: "codex",
        planType: "plus",
        usedPercent: 12.5,
        remainingPercent: 87.5,
        estimate: null,
      },
      report: {
        aggregate: {
          requestCount: 2,
          unsuccessfulRequestCount: 1,
        },
      },
      errors: {
        requestCount: 2,
        unsuccessfulRequestCount: 1,
        groups: [{
          status: "incomplete",
          errorType: "response_not_observed",
        }],
      },
    });
    const exported = readMetricsExport(environment, { range: "24h", nowMs });
    expect(exported).toMatchObject({
      format: "codex-connect-request-metrics-export",
      version: 3,
      weeklyQuota: {
        limitId: "codex",
        planType: "plus",
        usedPercent: 12.5,
      },
    });
    expect(exported.records).toHaveLength(2);
    expect(exported.records[1]).toMatchObject({
      status: "incomplete",
      incompleteReason: "response_not_observed",
    });
    expect(JSON.stringify(exported)).not.toMatch(/prompt|authorization|"message":/iu);
  });

  it("exports request quota snapshots separately from the current quota summary", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    const resetsAt = Math.floor(Date.now() / 1_000) + 24 * 60 * 60;
    store.record({
      ...metricSample(),
      provider: "openai",
      weeklyQuota: {
        limitId: "codex",
        planType: "plus",
        usedPercentMillionths: 12_500_000,
        resetsAt,
      },
    });
    store.record({
      ...metricSample(),
      provider: "openai",
      threadId: "thread-2",
      turnId: "turn-2",
    });
    store.close();

    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "metrics-database.mjs"),
        "export",
        "--range",
        "24h",
        "--format",
        "csv",
      ],
      { encoding: "utf8", env: environment },
    );

    expect(result.status, result.stderr).toBe(0);
    const [headings = [], ...values] = result.stdout.trim().split("\n")
      .map((line) => line.split(","));
    const rows = values.map((cells) => Object.fromEntries(
      headings.map((heading, index) => [heading, cells[index] ?? ""]),
    ));
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([
      expect.objectContaining({
        type: "request",
        id: "1",
        weeklyQuotaPlanType: "plus",
        weeklyQuotaUsedPercent: "12.5",
      }),
      expect.objectContaining({
        type: "request",
        id: "2",
        weeklyQuotaUsedPercent: "",
      }),
      expect.objectContaining({
        type: "weekly_quota_summary",
        id: "",
        weeklyQuotaPlanType: "plus",
        weeklyQuotaUsedPercent: "12.5",
      }),
    ]);
  });

  it("shows compact model and tokens in reports and exports", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record(metricSample());
    store.record({ ...metricSample(), operation: "compact" });
    store.close();

    expect(readMetricsReport(environment, {
      range: "24h",
      group: "global",
      nowMs: Date.now() + 1,
    }).report.aggregate).toMatchObject({
      compact: {
        model: "deepseek-v4-flash",
        requestCount: 1,
        inputTokens: 1_000,
        outputTokens: 100,
      },
    });

    const reportMarkdown = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "metrics-database.mjs"),
        "report",
        "--range",
        "24h",
        "--group",
        "global",
        "--format",
        "markdown",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(reportMarkdown.status, reportMarkdown.stderr).toBe(0);
    expect(reportMarkdown.stdout).toContain(
      "上下文压缩：1 次 · deepseek-v4-flash · 1.1 K Token",
    );
    expect(reportMarkdown.stdout).toContain("推理输出 Token：");

    const exportMarkdown = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "metrics-database.mjs"),
        "export",
        "--range",
        "24h",
        "--format",
        "markdown",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(exportMarkdown.status, exportMarkdown.stderr).toBe(0);
    expect(exportMarkdown.stdout).toContain("| 操作 |");
    expect(exportMarkdown.stdout).toContain("| compact |");

    const reportCsv = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts", "metrics-database.mjs"),
        "report",
        "--range",
        "24h",
        "--group",
        "global",
        "--format",
        "csv",
      ],
      { encoding: "utf8", env: environment },
    );
    expect(reportCsv.status, reportCsv.stderr).toBe(0);
    expect(reportCsv.stdout).toContain("compactRequestCount");
  });

  it("exports a single Thread run summary and filters export by Thread", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record(metricSample());
    store.record({
      ...metricSample(),
      threadId: "thread-2",
      turnId: "turn-2",
      inputTokens: 200,
      cachedInputTokens: 100,
      outputTokens: 50,
    });
    store.close();
    const nowMs = Date.now() + 1;

    const run = readMetricsRun(environment, "thread-1");
    expect(run).toMatchObject({
      format: "codex-connect-request-metrics-run",
      version: 2,
      threadId: "thread-1",
      latestTurn: {
        turnId: "turn-1",
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
        requestCount: 1,
        inputTokens: 1_000,
      },
      threadAggregate: {
        turnCount: 1,
        requestCount: 1,
      },
    });

    const filtered = readMetricsExport(environment, {
      range: "24h",
      nowMs,
      threadId: "thread-2",
    });
    expect(filtered.records).toHaveLength(1);
    expect((filtered.records[0] as { threadId?: string } | undefined)?.threadId)
      .toBe("thread-2");

    const threads = readMetricsThreads(environment);
    expect(threads.threads).toEqual([
      expect.objectContaining({
        threadId: "thread-2",
        turnCount: 1,
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
      }),
      expect.objectContaining({
        threadId: "thread-1",
        turnCount: 1,
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
      }),
    ]);

    const turns = readMetricsTurns(environment, "thread-1");
    expect(turns).toMatchObject({
      format: "codex-connect-request-metrics-turns",
      version: 2,
      threadId: "thread-1",
      turns: [{
        turnId: "turn-1",
        model: "deepseek-v4-flash",
        reasoningEffort: "max",
        requestCount: 1,
        inputTokens: 1_000,
      }],
    });
  });

});
