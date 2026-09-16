import {
  chmodSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupMetricsDatabase,
  cleanupMetricsDatabaseWithGatewayRestart,
  pruneProviderMetrics,
} from "../scripts/metrics-database.mjs";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import {
  cleanupMetricsDatabaseTestFixtures,
  createMetricsDatabaseTestFixture,
  metricSample,
} from "./metrics-database-test-fixture.js";
import { secureTestDirectory, secureTestFile } from "./support/windows-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  cleanupMetricsDatabaseTestFixtures(temporaryDirectories);
});

function fixture() {
  return createMetricsDatabaseTestFixture(temporaryDirectories);
}

describe("model request metrics database cleanup and pruning", () => {
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

  it("prunes OpenAI rows from the local database and restarts Gateway", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "deepseek" });
    store.record({ ...metricSample(), provider: "deepseek" });
    store.record({ ...metricSample(), provider: "openai" });
    store.close();

    const calls: string[] = [];
    const result = pruneProviderMetrics("openai", environment, {
      localDatabasePath: databasePath,
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
    });

    expect(calls).toEqual(["stop:gateway", "start:gateway"]);
    expect(result.local.deleted).toBe(1);
    expect(result.warnings).toEqual([]);

    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'deepseek'
    `).get()).toMatchObject({ c: 2 });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 0 });
    local.close();

    expect(existsSync(result.local.backupPath ?? "")).toBe(true);
  });

  it("preserves a stopped Gateway during pruning", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "openai" });
    store.close();
    const calls: string[] = [];

    const result = pruneProviderMetrics("openai", environment, {
      localDatabasePath: databasePath,
      gatewayRunning: false,
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
    });

    expect(result.local.deleted).toBe(1);
    expect(result).toMatchObject({ gatewayWasRunning: false });
    expect(calls).toEqual([]);
  });

  it("treats a missing local database as empty without creating it", () => {
    const { environment, databasePath } = fixture();

    const result = pruneProviderMetrics("openai", environment, {
      localDatabasePath: databasePath,
      stopGateway: () => undefined,
      startGateway: () => undefined,
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
      stopGateway: () => {
        calls.push("stop:gateway");
        throw new Error("stop failed");
      },
      startGateway: () => calls.push("start:gateway"),
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
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
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
        stopGateway: () => calls.push("stop:gateway"),
        startGateway: () => calls.push("start:gateway"),
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
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
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
      stopGateway: () => calls.push("stop:gateway"),
      startGateway: () => calls.push("start:gateway"),
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
    secureTestDirectory(privateDirectory);
    secureTestFile(join(privateDirectory, "primary-providers.json"), JSON.stringify({
      OpenAI: {
        base_url: "https://zzone.example.test/v1",
        wire_api: "responses",
      },
    }));
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), provider: "OpenAI" });
    store.record({ ...metricSample(), provider: "openai" });
    store.close();

    const result = pruneProviderMetrics("OpenAI", environment, {
      localDatabasePath: databasePath,
      stopGateway: () => undefined,
      startGateway: () => undefined,
    });

    expect(result.provider).toBe("OpenAI");
    expect(result.local.deleted).toBe(1);
    const local = new DatabaseSync(databasePath, { readOnly: true });
    expect(local.prepare(`
      SELECT COUNT(*) AS c FROM model_request_metrics WHERE provider = 'openai'
    `).get()).toMatchObject({ c: 1 });
    local.close();
  });

  it("rejects an invalid provider identifier", () => {
    const { environment, databasePath } = fixture();
    expect(() => pruneProviderMetrics("provider with spaces", environment, {
      localDatabasePath: databasePath,
      stopGateway: () => undefined,
      startGateway: () => undefined,
    })).toThrow("codexc metrics prune <provider>");
  });

});
