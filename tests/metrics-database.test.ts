import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupMetricsDatabase,
  cleanupMetricsDatabaseWithGatewayRestart,
  inspectMetricsDatabase,
  metricsRange,
  pruneProviderMetrics,
  readMetricsExport,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  resetMetricsDatabase,
  resetMetricsSyncState,
  resetMetricsSyncStateWithGatewayRestart,
  upgradeMetricsDatabase,
  upgradeMetricsDatabaseWithGatewayRestart,
  validateMetricsDatabaseStructure,
} from "../scripts/metrics-database.mjs";
import {
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelRequestMetricSample,
} from "../src/observability/index.js";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model request metrics database operations", () => {
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

  it("backs up and manually cleans metrics using caller limits", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record(metricSample());
    store.record({ ...metricSample(), threadId: "thread-2", turnId: "turn-2" });
    store.close();

    const result = cleanupMetricsDatabase(environment, {
      before: "2999-01-01",
      maxRows: 1_000_000,
      gatewayRunning: () => false,
    });

    expect(result).toMatchObject({ deleted: 2, remaining: 0, vacuumed: false });
    expect(existsSync(result.backupPath)).toBe(true);
  });

  it.runIf(process.platform === "linux")(
    "runs manual cleanup through the CLI entry point",
    () => {
      const { environment, databasePath, home } = fixture();
      const store = new SqliteModelRequestMetricsStore(databasePath);
      store.record(metricSample());
      store.close();
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);

      const result = spawnSync(
        process.execPath,
        [
          join(process.cwd(), "scripts", "metrics-database.mjs"),
          "cleanup",
          "--before",
          "2999-01-01",
          "--max-rows",
          "1000000",
        ],
        {
          encoding: "utf8",
          env: {
            ...environment,
            NODE_NO_WARNINGS: "1",
            SYSTEMCTL_BINARY: systemctl,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("已清理 1 条指标，剩余 0 条");
      expect(result.stdout).toContain("备份：");
      expect(result.stderr).toBe("");
    },
  );

  it("rejects invalid cleanup policy before restarting the Gateway", () => {
    const { environment } = fixture();
    const calls: string[] = [];

    expect(() => cleanupMetricsDatabaseWithGatewayRestart(environment, {
      before: "not-a-date",
      stopGateway: () => calls.push("stop"),
      startGateway: () => calls.push("start"),
    })).toThrow(/YYYY-MM-DD/u);
    expect(calls).toEqual([]);
  });

  it("prunes OpenAI rows from local and center databases and restarts services", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "deepseek" });
    store.record({ ...metricSample(), provider: "deepseek" });
    store.record({ ...metricSample(), provider: "openai" });
    store.close();

    const centerPath = join(dirname(databasePath), "center.sqlite3");
    const center = new DatabaseSync(centerPath);
    center.exec(`
      CREATE TABLE request_metrics (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL
      )
    `);
    center.prepare("INSERT INTO request_metrics (provider) VALUES (?)")
      .run("deepseek");
    center.prepare("INSERT INTO request_metrics (provider) VALUES (?)")
      .run("openai");
    center.close();

    const calls: string[] = [];
    const result = pruneProviderMetrics("openai", environment, {
      localDatabasePath: databasePath,
      centerDatabasePath: centerPath,
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
      stopCenter: () => calls.push("stop:center"),
      startCenter: () => calls.push("start:center"),
    });

    expect(calls).toEqual([
      "stop:gateway",
      "stop:center",
      "start:center",
      "start:gateway",
    ]);
    expect(result.local.deleted).toBe(1);
    expect(result.center).toMatchObject({ skipped: false, deleted: 1 });
    expect(result.warnings).toEqual([]);

    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'deepseek'
    `).get()).toMatchObject({ c: 2 });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 0 });
    local.close();

    const centerAfter = new DatabaseSync(centerPath, { readOnly: true });
    expect(centerAfter.prepare(`
      SELECT COUNT(*) AS c FROM request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 0 });
    centerAfter.close();

    expect(existsSync(result.local.backupPath ?? "")).toBe(true);
    expect(existsSync(result.center.backupPath ?? "")).toBe(true);
  });

  it("skips the center database when it is not configured", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "openai" });
    store.close();
    const calls: string[] = [];

    const result = pruneProviderMetrics("openai", environment, {
      localDatabasePath: databasePath,
      centerDatabasePath: null,
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
      stopCenter: () => calls.push("stop:center"),
      startCenter: () => calls.push("start:center"),
    });

    expect(result.center.skipped).toBe(true);
    expect(result.local.deleted).toBe(1);
    expect(calls).toEqual(["stop:gateway", "start:gateway"]);
  });

  it("treats a missing local database as empty without creating it", () => {
    const { environment, databasePath } = fixture();

    const result = pruneProviderMetrics("openai", environment, {
      localDatabasePath: databasePath,
      centerDatabasePath: null,
      stopGateway: () => undefined,
      startGateway: () => undefined,
      stopCenter: () => undefined,
      startCenter: () => undefined,
    });

    expect(result.local).toMatchObject({ backupPath: null, deleted: 0 });
    expect(existsSync(databasePath)).toBe(false);
  });

  it("fails closed and restarts services when stopping the Gateway fails", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "openai" });
    store.close();
    const calls: string[] = [];

    expect(() => pruneProviderMetrics("openai", environment, {
      localDatabasePath: databasePath,
      centerDatabasePath: null,
      stopGateway: () => {
        calls.push("stop:gateway");
        throw new Error("stop failed");
      },
      startGateway: () => calls.push("start:gateway"),
      stopCenter: () => calls.push("stop:center"),
      startCenter: () => calls.push("start:center"),
    })).toThrow("stop failed");

    expect(calls).toEqual(["stop:gateway", "start:gateway"]);
    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 1 });
    local.close();
  });

  it("restarts services and surfaces the failure when the delete fails", () => {
    const { environment, databasePath } = fixture();
    const badPath = join(dirname(databasePath), "bad.sqlite3");
    const bad = new DatabaseSync(badPath);
    bad.exec("CREATE TABLE model_request_metrics (id INTEGER PRIMARY KEY)");
    bad.close();
    const calls: string[] = [];

    expect(() => pruneProviderMetrics("openai", environment, {
      localDatabasePath: badPath,
      centerDatabasePath: null,
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
      stopCenter: () => calls.push("stop:center"),
      startCenter: () => calls.push("start:center"),
    })).toThrow();
    expect(calls).toEqual(["stop:gateway", "start:gateway"]);
  });

  it("fails closed before deleting when the metrics database cannot be backed up", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "openai" });
    store.close();
    const lock = new DatabaseSync(databasePath);
    lock.exec("BEGIN EXCLUSIVE");
    const calls: string[] = [];

    try {
      expect(() => pruneProviderMetrics("openai", environment, {
        localDatabasePath: databasePath,
        centerDatabasePath: null,
        stopGateway: () => calls.push("stop:gateway"),
        startGateway: () => calls.push("start:gateway"),
        stopCenter: () => calls.push("stop:center"),
        startCenter: () => calls.push("start:center"),
      })).toThrow("备份指标数据库失败");
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }

    expect(calls).toEqual(["stop:gateway", "start:gateway"]);
    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 1 });
    local.close();
  });

  it("backs up every configured database before deleting from either one", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "openai" });
    store.close();
    const centerPath = join(dirname(databasePath), "center-locked.sqlite3");
    const center = new DatabaseSync(centerPath);
    center.exec(`
      CREATE TABLE request_metrics (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL
      )
    `);
    center.prepare("INSERT INTO request_metrics (provider) VALUES (?)").run("openai");
    center.exec("BEGIN EXCLUSIVE");

    try {
      expect(() => pruneProviderMetrics("openai", environment, {
        localDatabasePath: databasePath,
        centerDatabasePath: centerPath,
        stopGateway: () => undefined,
        startGateway: () => undefined,
        stopCenter: () => undefined,
        startCenter: () => undefined,
      })).toThrow("备份指标数据库失败");
    } finally {
      center.exec("ROLLBACK");
      center.close();
    }

    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 1 });
    local.close();
  });

  it("prunes rows for the requested provider", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "deepseek" });
    store.record({ ...metricSample(), provider: "opencode-go" });
    store.record({ ...metricSample(), provider: "openai" });
    store.close();
    const calls: string[] = [];

    const result = pruneProviderMetrics("opencode-go", environment, {
      localDatabasePath: databasePath,
      centerDatabasePath: null,
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
      stopCenter: () => calls.push("stop:center"),
      startCenter: () => calls.push("start:center"),
    });

    expect(result.provider).toBe("opencode-go");
    expect(result.local.deleted).toBe(1);
    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 1 });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'deepseek'
    `).get()).toMatchObject({ c: 1 });
    local.close();
  });

  it("prunes rows for a configured custom primary Provider", () => {
    const { environment, databasePath, home } = fixture();
    const codexHome = join(home, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "OpenAI"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://zzone.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });
    const environmentWithCustomPrimary = {
      ...environment,
      CODEX_HOME: codexHome,
    };
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "OpenAI" });
    store.record({ ...metricSample(), provider: "openai" });
    store.close();
    const calls: string[] = [];

    const result = pruneProviderMetrics("OpenAI", environmentWithCustomPrimary, {
      localDatabasePath: databasePath,
      centerDatabasePath: null,
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
      stopCenter: () => calls.push("stop:center"),
      startCenter: () => calls.push("start:center"),
    });

    expect(result.provider).toBe("OpenAI");
    expect(result.local.deleted).toBe(1);
    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 1 });
    local.close();
  });

  it("prunes rows for a backed-up custom primary Provider", () => {
    const { environment, databasePath, home } = fixture();
    const privateDirectory = join(home, "private");
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 });
    writeFileSync(join(privateDirectory, "primary-providers.json"), JSON.stringify({
      OpenAI: {
        base_url: "https://zzone.example.test/v1",
        wire_api: "responses",
      },
    }), { mode: 0o600 });
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "OpenAI" });
    store.record({ ...metricSample(), provider: "openai" });
    store.close();

    const result = pruneProviderMetrics("OpenAI", environment, {
      localDatabasePath: databasePath,
      centerDatabasePath: null,
      stopGateway: () => undefined,
      startGateway: () => undefined,
      stopCenter: () => undefined,
      startCenter: () => undefined,
    });

    expect(result.provider).toBe("OpenAI");
    expect(result.local.deleted).toBe(1);
    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 1 });
    local.close();
  });

  it("rejects an unsupported provider", () => {
    const { environment, databasePath } = fixture();
    expect(() => pruneProviderMetrics("unknown", environment, {
      localDatabasePath: databasePath,
      centerDatabasePath: null,
      stopGateway: () => undefined,
      startGateway: () => undefined,
      stopCenter: () => undefined,
      startCenter: () => undefined,
    })).toThrow("codexc metrics prune <provider>");
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
      firstTokenAtMs: null,
      firstReasoningDeltaAtMs: null,
      lastReasoningDeltaAtMs: null,
      firstOutputDeltaAtMs: null,
      lastOutputDeltaAtMs: null,
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
      version: 2,
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
      version: 2,
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

  it("shows compact model, tokens, and reference cost in reports and exports", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    const pricing = {
      billingMode: "api" as const,
      currency: "USD",
      source: "test-catalog",
      effectiveAtMs: 1_700_000_000_000,
      uncachedInputPricePerMillionNanos: 2_000_000_000,
      cachedInputPricePerMillionNanos: 1_000_000_000,
      outputPricePerMillionNanos: 3_000_000_000,
    };
    store.record({ ...metricSample(), pricing });
    store.record({ ...metricSample(), operation: "compact", pricing });
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
        pricingCurrency: "USD",
        totalCostNanos: 1_400_000,
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
      "上下文压缩：1 次 · deepseek-v4-flash · 1.1 K Token · $0.0014",
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
    expect(reportCsv.stdout).toContain("compactTotalCostNanos");
  });

  it("refuses to reset while Gateway is running", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, 1, 1);

    expect(() => resetMetricsDatabase(environment, {
      gatewayRunning: () => true,
    })).toThrow(/codexc service stop gateway/u);
    expect(existsSync(databasePath)).toBe(true);
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
      version: 1,
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
      version: 1,
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

  it.runIf(process.platform === "linux")(
    "fails closed when systemd reports a failed Gateway service",
    () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nprintf 'failed\\n'\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);

      expect(() => resetMetricsDatabase({
        ...environment,
        SYSTEMCTL_BINARY: systemctl,
      })).toThrow(/Gateway/u);
      expect(existsSync(databasePath)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "fails closed when the Gateway service state cannot be queried",
    () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);

      expect(() => resetMetricsDatabase({
        ...environment,
        SYSTEMCTL_BINARY: systemctl,
      })).toThrow(/无法确认 Gateway 服务状态/u);
      expect(existsSync(databasePath)).toBe(true);
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses to reset while a foreground Gateway metrics socket is active",
    async () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);
      const socketPath = join(home, "runtime", "codex-app-server-openai-metrics.sock");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });

      try {
        expect(() => resetMetricsDatabase({
          ...environment,
          SYSTEMCTL_BINARY: systemctl,
        })).toThrow(/Gateway/u);
        expect(existsSync(databasePath)).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "allows reset when only a stale metrics socket path remains",
    () => {
      const { environment, databasePath, home } = fixture();
      createMetricsDatabase(databasePath, 1, 1);
      const systemctl = join(home, "systemctl");
      writeFileSync(systemctl, "#!/bin/sh\nprintf 'inactive\\n'\n", { mode: 0o700 });
      chmodSync(systemctl, 0o700);
      writeFileSync(
        join(home, "runtime", "codex-app-server-openai-metrics.sock"),
        "stale",
        { mode: 0o600 },
      );

      expect(resetMetricsDatabase({
        ...environment,
        SYSTEMCTL_BINARY: systemctl,
      }).changed).toBe(true);
    },
  );

  it("checkpoints, backs up and removes an offline database", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, 1, 2);

    const result = resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-02T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 1,
    });
    expect(result.backupPath).toContain(".v1.2026-08-02T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(existsSync(databasePath)).toBe(false);
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get())
      .toEqual({ count: 2 });
    backup.close();
  });

  it("backs up and explicitly upgrades a v3 metrics database in place", () => {
    const { environment, databasePath } = fixture();
    createLegacyV3Database(databasePath, 2);
    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).not.toThrow();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 3,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v3.2026-08-05T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_threads'",
    ).get()).toEqual({ name: "subagent_threads" });
    const columns = database.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "weekly_quota_limit_id",
      "weekly_used_percent_millionths",
      "weekly_resets_at",
      "weekly_quota_plan_type",
      "error_message",
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get())
      .toEqual({ count: 2 });
    database.close();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    expect(store.count()).toBe(2);
    store.close();
  });

  it("backs up and explicitly upgrades a v4 metrics database in place", () => {
    const { environment, databasePath } = fixture();
    createLegacyV4Database(databasePath, 2);
    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).not.toThrow();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 4,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v4.2026-08-05T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    const columns = database.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "weekly_quota_plan_type",
      "error_message",
    ]));
    database.close();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    expect(store.count()).toBe(2);
    store.close();
  });

  it("backs up and explicitly upgrades a v5 metrics database in place", () => {
    const { environment, databasePath } = fixture();
    createLegacyV5Database(databasePath, 2);
    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).not.toThrow();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 5,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v5.2026-08-05T12-34-56-789Z.bak");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    const columns = database.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "error_message",
    ]));
    database.close();
  });

  it("backs up and explicitly upgrades a v6 metrics database in place", () => {
    const { environment, databasePath } = fixture();
    createLegacyV6Database(databasePath, 2);
    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).not.toThrow();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 6,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v6.2026-08-05T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subagent_threads'",
    ).get()).toEqual({ name: "subagent_threads" });
    database.close();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    expect(store.count()).toBe(2);
    store.close();
  });

  it("backs up and explicitly upgrades a v7 metrics database in place", () => {
    const { environment, databasePath } = fixture();
    createLegacyV6Database(databasePath, 2);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      UPDATE schema_metadata SET value = 7 WHERE name = 'schema_version';
    `);
    database.close();
    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).not.toThrow();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 7,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v7.2026-08-05T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    expect(upgraded.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    const columns = upgraded.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "pricing_bucket",
    ]));
    upgraded.close();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    expect(store.count()).toBe(2);
    store.close();
  });

  it("backs up and explicitly upgrades a v8 metrics database in place", () => {
    const { environment, databasePath } = fixture();
    createLegacyV6Database(databasePath, 2);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      ALTER TABLE model_request_metrics ADD COLUMN pricing_bucket TEXT
        CHECK (pricing_bucket IS NULL OR pricing_bucket IN ('peak', 'off-peak'));
      UPDATE schema_metadata SET value = 8 WHERE name = 'schema_version';
    `);
    database.close();
    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).not.toThrow();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 8,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v8.2026-08-05T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    expect(upgraded.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    const columns = upgraded.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "pricing_bucket",
      "quota_windows",
    ]));
    upgraded.close();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    expect(store.count()).toBe(2);
    store.close();
  });

  it("backs up and upgrades v9 annotations without guessing historical parent Turns", () => {
    const { environment, databasePath } = fixture();
    createLegacyV6Database(databasePath, 2);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      ALTER TABLE model_request_metrics ADD COLUMN pricing_bucket TEXT
        CHECK (pricing_bucket IS NULL OR pricing_bucket IN ('peak', 'off-peak'));
      ALTER TABLE model_request_metrics ADD COLUMN quota_windows TEXT;
      CREATE TABLE subagent_threads (
        thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        agent_path TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      );
      INSERT INTO subagent_threads
        (thread_id, parent_thread_id, agent_path, recorded_at_ms)
      VALUES ('legacy-child', 'root', '/root/legacy', 1000);
      UPDATE schema_metadata SET value = 9 WHERE name = 'schema_version';
    `);
    database.close();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      previousSchemaVersion: 9,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v9.2026-08-05T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    expect(upgraded.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    expect(upgraded.prepare(
      "SELECT parent_turn_id FROM subagent_threads WHERE thread_id = 'legacy-child'",
    ).get()).toEqual({ parent_turn_id: null });
    upgraded.close();
  });

  it("backs up and upgrades v10 to v11 without guessing historical subagent runs", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record(metricSample());
    store.recordSubagentThread({
      agentThreadId: "legacy-child",
      parentThreadId: "root",
      parentTurnId: "root-turn",
      agentPath: "/root/legacy",
    });
    store.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      DROP INDEX subagent_turns_parent_turn;
      DROP TABLE subagent_turns;
      UPDATE schema_metadata SET value = 10 WHERE name = 'schema_version';
    `);
    legacy.close();

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      previousSchemaVersion: 10,
      schemaVersion: 11,
    });
    expect(result.backupPath).toContain(".v10.2026-08-05T12-34-56-789Z.bak");
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    expect(upgraded.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: 11 });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get())
      .toEqual({ count: 1 });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM subagent_threads").get())
      .toEqual({ count: 1 });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM subagent_turns").get())
      .toEqual({ count: 0 });
    upgraded.close();
  });

  it("rolls back the v9 to v10 migration when structural validation fails", () => {
    const { environment, databasePath } = fixture();
    createLegacyV6Database(databasePath, 1);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      ALTER TABLE model_request_metrics ADD COLUMN pricing_bucket TEXT
        CHECK (pricing_bucket IS NULL OR pricing_bucket IN ('peak', 'off-peak'));
      ALTER TABLE model_request_metrics ADD COLUMN quota_windows TEXT;
      CREATE TABLE subagent_threads (
        thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      );
      UPDATE schema_metadata SET value = 9 WHERE name = 'schema_version';
    `);
    database.close();

    expect(() => upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    })).toThrow(/subagent_threads 缺少 agent_path/u);

    expect(inspectMetricsDatabase(environment).schemaVersion).toBe(9);
    const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
    const columns = rolledBack.prepare("PRAGMA table_info(subagent_threads)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("parent_turn_id");
    rolledBack.close();
    expect(existsSync(
      `${databasePath}.v9.2026-08-05T12-34-56-789Z.bak`,
    )).toBe(true);
  });

  it("rolls back the v10 to v11 migration when the run relation is malformed", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record(metricSample());
    store.close();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      DROP INDEX subagent_turns_parent_turn;
      DROP TABLE subagent_turns;
      CREATE TABLE subagent_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        parent_turn_id TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );
      UPDATE schema_metadata SET value = 10 WHERE name = 'schema_version';
    `);
    database.close();

    expect(() => upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    })).toThrow(/subagent_turns 缺少 agent_path/u);

    expect(inspectMetricsDatabase(environment).schemaVersion).toBe(10);
    const rolledBack = new DatabaseSync(databasePath, { readOnly: true });
    expect(rolledBack.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: 10 });
    const columns = rolledBack.prepare("PRAGMA table_info(subagent_turns)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain("agent_path");
    rolledBack.close();
    const backupPath = `${databasePath}.v10.2026-08-05T12-34-56-789Z.bak`;
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  });

  it("refuses metrics upgrades while Gateway is running", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, 3, 1);

    expect(() => upgradeMetricsDatabase(environment, {
      gatewayRunning: () => true,
    })).toThrow(/codexc service stop gateway/u);
    expect(inspectMetricsDatabase(environment).schemaVersion).toBe(3);
  });

  it("fails closed instead of guessing an unsupported metrics upgrade", () => {
    const { environment, databasePath } = fixture();
    createMetricsDatabase(databasePath, 2, 1);

    expect(() => upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
    })).toThrow(/仅支持 v3\/v4\/v5\/v6\/v7\/v8\/v9\/v10 升级到 v11/u);
    expect(inspectMetricsDatabase(environment).schemaVersion).toBe(2);
  });

  it("stops, upgrades and restarts Gateway in order", () => {
    const calls: string[] = [];
    const result = upgradeMetricsDatabaseWithGatewayRestart(process.env, {
      stopGateway: () => calls.push("stop"),
      upgrade: () => {
        calls.push("upgrade");
        return {
          backupPath: "/tmp/metrics-v3.bak",
          changed: true,
          databasePath: "/tmp/metrics.sqlite3",
          previousSchemaVersion: 3,
          schemaVersion: 4,
        };
      },
      startGateway: () => calls.push("start"),
    });

    expect(calls).toEqual(["stop", "upgrade", "start"]);
    expect(result.schemaVersion).toBe(4);
  });

  it("still restarts Gateway when the upgrade fails", () => {
    const calls: string[] = [];
    expect(() => upgradeMetricsDatabaseWithGatewayRestart(process.env, {
      stopGateway: () => calls.push("stop"),
      upgrade: () => {
        calls.push("upgrade");
        throw new Error("upgrade failed");
      },
      startGateway: () => calls.push("start"),
    })).toThrow(/upgrade failed/u);
    expect(calls).toEqual(["stop", "upgrade", "start"]);
  });

  it("still attempts upgrade and restart when stopping Gateway fails", () => {
    const calls: string[] = [];
    expect(() => upgradeMetricsDatabaseWithGatewayRestart(process.env, {
      stopGateway: () => {
        calls.push("stop");
        throw new Error("stop failed");
      },
      upgrade: () => {
        calls.push("upgrade");
        return {
          backupPath: "/tmp/metrics-v3.bak",
          changed: true,
          databasePath: "/tmp/metrics.sqlite3",
          previousSchemaVersion: 3,
          schemaVersion: 4,
        };
      },
      startGateway: () => calls.push("start"),
    })).toThrow(/stop failed/u);
    expect(calls).toEqual(["stop", "upgrade", "start"]);
  });

  it("combines stop and start failures after a failed upgrade", () => {
    expect(() => upgradeMetricsDatabaseWithGatewayRestart(process.env, {
      stopGateway: () => {
        throw new Error("stop failed");
      },
      upgrade: () => {
        throw new Error("upgrade failed");
      },
      startGateway: () => {
        throw new Error("start failed");
      },
    })).toThrow(AggregateError);
  });

  it("resets the metrics sync watermark while keeping the device id", () => {
    const { environment, home } = fixture();
    const statePath = join(home, "data", "metrics-sync-state.json");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      deviceId: "main-server",
      lastRequestLocalId: 42,
      lastSubagentRecordedAtMs: 1_000,
      lastSubagentThreadId: "sub-1",
    }, null, 2) + "\n", { mode: 0o600 });

    const result = resetMetricsSyncState(environment, {
      gatewayRunning: () => false,
    });

    expect(result).toMatchObject({
      changed: true,
      statePath,
      deviceId: "main-server",
    });
    expect(existsSync(result.backupPath ?? "")).toBe(true);
    const next = JSON.parse(readFileSync(statePath, "utf8")) as {
      version: number;
      deviceId: string;
      lastRequestLocalId: number;
      lastSubagentRecordedAtMs: number;
      lastSubagentThreadId: string | null;
    };
    expect(next).toEqual({
      version: 1,
      deviceId: "main-server",
      lastRequestLocalId: 0,
      lastSubagentRecordedAtMs: 0,
      lastSubagentThreadId: null,
    });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("does nothing when the metrics sync state does not exist", () => {
    const { environment, home } = fixture();

    expect(resetMetricsSyncState(environment, {
      gatewayRunning: () => false,
    })).toEqual({
      backupPath: null,
      changed: false,
      statePath: join(home, "data", "metrics-sync-state.json"),
    });
  });

  it("refuses to reset the sync watermark while Gateway is running", () => {
    const { environment, home } = fixture();
    const statePath = join(home, "data", "metrics-sync-state.json");
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      deviceId: "main-server",
      lastRequestLocalId: 42,
      lastSubagentRecordedAtMs: 0,
      lastSubagentThreadId: null,
    }), { mode: 0o600 });

    expect(() => resetMetricsSyncState(environment, {
      gatewayRunning: () => true,
    })).toThrow(/Gateway 仍在运行/u);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      lastRequestLocalId: 42,
    });
  });

  it("stops, resets and restarts Gateway in order", () => {
    const calls: string[] = [];

    resetMetricsSyncStateWithGatewayRestart(process.env, {
      stopGateway: () => calls.push("stop"),
      reset: () => {
        calls.push("reset");
        return {
          backupPath: "/tmp/sync.bak",
          changed: true,
          statePath: "/tmp/sync-state.json",
          deviceId: "main-server",
        };
      },
      startGateway: () => calls.push("start"),
    });

    expect(calls).toEqual(["stop", "reset", "start"]);
  });

  it("refuses to reset when an unmanaged Gateway still owns the metrics database", () => {
    const { environment, databasePath } = fixture();
    const active = new SqliteModelRequestMetricsStore(databasePath);

    expect(() => resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
    })).toThrow(/正在使用/u);
    expect(existsSync(databasePath)).toBe(true);

    active.close();
    expect(resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
    }).changed).toBe(true);
  });

  it("is idempotent when no metrics database exists", () => {
    const { environment, databasePath } = fixture();

    expect(resetMetricsDatabase(environment, {
      gatewayRunning: () => false,
    })).toEqual({
      backupPath: null,
      changed: false,
      databasePath,
      previousSchemaVersion: null,
    });
  });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codexc-metrics-database-"));
  temporaryDirectories.push(home);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  initializeUserData({ environment, cwd: home });
  return {
    databasePath: requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    environment,
    home,
  };
}

function createMetricsDatabase(path: string, schemaVersion: number, count: number) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO schema_metadata (name, value) VALUES ('schema_version', ${schemaVersion});
    CREATE TABLE model_request_metrics (id INTEGER PRIMARY KEY);
  `);
  const insert = database.prepare("INSERT INTO model_request_metrics DEFAULT VALUES");
  for (let index = 0; index < count; index += 1) insert.run();
  database.close();
}

function createLegacyV3Database(path: string, count: number) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO schema_metadata (name, value) VALUES ('schema_version', 3);
    CREATE TABLE model_request_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      billing_mode TEXT CHECK (
        billing_mode IS NULL OR billing_mode IN ('api', 'subscription', 'unknown')
      ),
      pricing_currency TEXT,
      pricing_source TEXT,
      pricing_effective_at_ms INTEGER,
      uncached_input_price_per_million_nanos INTEGER CHECK (
        uncached_input_price_per_million_nanos IS NULL
        OR uncached_input_price_per_million_nanos >= 0
      ),
      cached_input_price_per_million_nanos INTEGER CHECK (
        cached_input_price_per_million_nanos IS NULL
        OR cached_input_price_per_million_nanos >= 0
      ),
      output_price_per_million_nanos INTEGER CHECK (
        output_price_per_million_nanos IS NULL
        OR output_price_per_million_nanos >= 0
      ),
      transport TEXT NOT NULL CHECK (transport IN ('http', 'websocket')),
      response_format TEXT NOT NULL CHECK (
        response_format IN ('sse', 'json', 'websocket', 'unknown')
      ),
      operation TEXT NOT NULL CHECK (operation IN ('response', 'compact')),
      thread_id TEXT,
      turn_id TEXT,
      model TEXT,
      service_tier TEXT,
      reasoning_effort TEXT,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'incomplete', 'unknown')),
      http_status INTEGER,
      error_type TEXT,
      error_code TEXT,
      incomplete_reason TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      total_tokens INTEGER,
      upstream_created_at REAL,
      upstream_completed_at REAL,
      request_started_at_ms INTEGER NOT NULL,
      first_token_at_ms INTEGER,
      first_reasoning_delta_at_ms INTEGER,
      last_reasoning_delta_at_ms INTEGER,
      first_output_delta_at_ms INTEGER,
      last_output_delta_at_ms INTEGER,
      response_completed_at_ms INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      CHECK (
        (
          billing_mode IS NULL
          AND pricing_currency IS NULL
          AND pricing_source IS NULL
          AND pricing_effective_at_ms IS NULL
          AND uncached_input_price_per_million_nanos IS NULL
          AND cached_input_price_per_million_nanos IS NULL
          AND output_price_per_million_nanos IS NULL
        ) OR (
          billing_mode IS NOT NULL
          AND pricing_source IS NOT NULL
          AND pricing_effective_at_ms IS NOT NULL
          AND (
            (
              uncached_input_price_per_million_nanos IS NULL
              AND cached_input_price_per_million_nanos IS NULL
              AND output_price_per_million_nanos IS NULL
            ) OR pricing_currency IS NOT NULL
          )
        )
      )
    );
    CREATE INDEX model_request_metrics_recorded_at
      ON model_request_metrics (recorded_at_ms);
    CREATE INDEX model_request_metrics_thread_turn
      ON model_request_metrics (thread_id, turn_id, id);
    CREATE INDEX model_request_metrics_provider_model
      ON model_request_metrics (provider, model, id);
    CREATE VIEW model_request_metrics_enriched AS
      SELECT id, 0 AS total_cost_nanos FROM model_request_metrics;
  `);
  const insert = database.prepare(`
    INSERT INTO model_request_metrics (
      provider, transport, response_format, operation, status,
      request_started_at_ms, response_completed_at_ms, recorded_at_ms
    ) VALUES (?, 'http', 'sse', 'response', 'completed', ?, ?, ?)
  `);
  const nowMs = Date.now();
  for (let index = 0; index < count; index += 1) {
    insert.run("openai", nowMs, nowMs + 1, nowMs + 2);
  }
  database.close();
}

function createLegacyV4Database(path: string, count: number) {
  createLegacyV3Database(path, count);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE model_request_metrics ADD COLUMN weekly_quota_limit_id TEXT
      CHECK (weekly_quota_limit_id IS NULL OR weekly_quota_limit_id = 'codex');
    ALTER TABLE model_request_metrics ADD COLUMN weekly_used_percent_millionths INTEGER
      CHECK (weekly_used_percent_millionths IS NULL
        OR weekly_used_percent_millionths BETWEEN 0 AND 100000000);
    ALTER TABLE model_request_metrics ADD COLUMN weekly_resets_at INTEGER
      CHECK (weekly_resets_at IS NULL OR weekly_resets_at >= 0);
    UPDATE schema_metadata SET value = 4 WHERE name = 'schema_version';
  `);
  database.close();
}

function createLegacyV5Database(path: string, count: number) {
  createLegacyV4Database(path, count);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE model_request_metrics ADD COLUMN weekly_quota_plan_type TEXT;
    UPDATE schema_metadata SET value = 5 WHERE name = 'schema_version';
  `);
  database.close();
}

function createLegacyV6Database(path: string, count: number) {
  createLegacyV5Database(path, count);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE model_request_metrics ADD COLUMN error_message TEXT;
    UPDATE schema_metadata SET value = 6 WHERE name = 'schema_version';
  `);
  database.close();
}

function metricSample(): ModelRequestMetricSample {
  return {
    provider: "deepseek",
    pricing: null,
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-1",
    turnId: "turn-1",
    model: "deepseek-v4-flash",
    serviceTier: "default",
    reasoningEffort: "max",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 1_100,
    upstreamCreatedAt: 1_785_640_800,
    upstreamCompletedAt: 1_785_640_801,
    requestStartedAtMs: 1_000,
    firstTokenAtMs: 1_100,
    firstReasoningDeltaAtMs: 1_100,
    lastReasoningDeltaAtMs: 1_300,
    firstOutputDeltaAtMs: 1_400,
    lastOutputDeltaAtMs: 1_600,
    responseCompletedAtMs: 1_650,
    weeklyQuota: null,
  };
}
