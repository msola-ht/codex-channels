import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  inspectMetricsDatabase,
  readMetricsExport,
  readMetricsReport,
  readMetricsRun,
  readMetricsThreads,
  readMetricsTurns,
  resetMetricsDatabase,
  upgradeMetricsDatabase,
  upgradeMetricsDatabaseWithGatewayRestart,
} from "../scripts/metrics-database.mjs";
import {
  modelRequestMetricsSchemaVersion,
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelRequestMetricSample,
} from "../src/observability/index.js";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("model request metrics database operations", () => {
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

  it("reads a reusable aggregate report and paged sanitized export", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({
      ...metricSample(),
      provider: "openai",
      weeklyQuota: {
        limitId: "codex",
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
        usedPercent: 12.5,
      },
    });
    expect(exported.records).toHaveLength(2);
    expect(exported.records[1]).toMatchObject({
      status: "incomplete",
      incompleteReason: "response_not_observed",
    });
    expect(JSON.stringify(exported)).not.toMatch(/prompt|message|authorization/iu);
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
      "远程压缩：1 次 · deepseek-v4-flash · 1.1 K Token · $0.0014",
    );

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
    createMetricsDatabase(databasePath, 3, 2);

    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-08-05T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      databasePath,
      previousSchemaVersion: 3,
      schemaVersion: 4,
    });
    expect(result.backupPath).toContain(".v3.2026-08-05T12-34-56-789Z.bak");
    expect(existsSync(result.backupPath!)).toBe(true);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    expect(database.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: 4 });
    const columns = database.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "weekly_quota_limit_id",
      "weekly_used_percent_millionths",
      "weekly_resets_at",
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get())
      .toEqual({ count: 2 });
    database.close();
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
    })).toThrow(/仅支持 v3 升级到 v4/u);
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
