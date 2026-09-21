import {
  existsSync,
  statSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectMetricsDatabase,
  upgradeMetricsDatabase,
  upgradeMetricsDatabaseWithGatewayRestart,
  validateMetricsDatabaseStructure,
} from "../scripts/metrics-database.mjs";
import {
  metricStorageColumns,
  modelRequestMetricsTableSql,
  modelRequestMetricsSchemaVersion,
  SqliteModelRequestMetricsStore,
} from "../src/observability/index.js";
import {
  cleanupMetricsDatabaseTestFixtures,
  createLegacyV3Database,
  createLegacyV4Database,
  createLegacyV5Database,
  createLegacyV6Database,
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

describe("model request metrics database upgrades", () => {
  it("upgrades v18 with unknown request tier while retaining response tier, timing and traffic", () => {
    const { environment, databasePath } = fixture();
    const traffic = { label: "openai", session: "retained", interaction: 3 };
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), serviceTier: "priority", totalDurationMs: 1234.5, traffic });
    store.close();
    const old = new DatabaseSync(databasePath);
    old.exec("ALTER TABLE model_request_metrics DROP COLUMN request_service_tier; UPDATE schema_metadata SET value = 18 WHERE name = 'schema_version';");
    old.close();
    expect(validateMetricsDatabaseStructure(environment, { allowUpgradeable: true }).schemaVersion).toBe(18);
    const result = upgradeMetricsDatabase(environment, { gatewayRunning: () => false });
    expect(result).toMatchObject({ previousSchemaVersion: 18, schemaVersion: 19 });
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get()?.value).toBe(18);
    backup.close();
    const upgraded = new SqliteModelRequestMetricsStore(databasePath);
    expect(upgraded.recent(1)[0]).toMatchObject({ requestServiceTier: null, serviceTier: "priority", totalDurationMs: 1234.5, traffic });
    upgraded.record({ ...metricSample(), requestServiceTier: "priority", serviceTier: "default" });
    expect(upgraded.recent(1)[0]).toMatchObject({ requestServiceTier: "priority", serviceTier: "default" });
    upgraded.close();
  });
  it("upgrades v17 preserving exact traffic links and leaving total duration unknown", () => {
    const { environment, databasePath } = fixture();
    const traffic = { label: "openai", session: "retained", interaction: 3 };
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), traffic, firstContentMs: 12.5 });
    store.close();
    const old = new DatabaseSync(databasePath);
    old.exec("ALTER TABLE model_request_metrics DROP COLUMN total_duration_ms; UPDATE schema_metadata SET value = 17 WHERE name = 'schema_version';");
    old.close();
    const result = upgradeMetricsDatabase(environment, { gatewayRunning: () => false });
    expect(result).toMatchObject({ previousSchemaVersion: 17, schemaVersion: 19 });
    const upgraded = new SqliteModelRequestMetricsStore(databasePath);
    expect(upgraded.recent(1)[0]).toMatchObject({ traffic, firstContentMs: 12.5, totalDurationMs: null });
    upgraded.record({ ...metricSample(), totalDurationMs: 1234.5 });
    expect(upgraded.recent(1)[0]?.totalDurationMs).toBe(1234.5);
    upgraded.close();
  });
  it("upgrades v16 without losing timing or models and never guesses historical traffic links", () => {
    const { environment, databasePath } = fixture();
    const current = new SqliteModelRequestMetricsStore(databasePath);
    current.record({ ...metricSample(), firstContentMs: 12.5, upstreamTtftMs: 672, requestModel: "sent", responseModel: "echoed" });
    current.close();
    const old = new DatabaseSync(databasePath);
    const columns = ["id", ...metricStorageColumns.filter((column) => !column.startsWith("traffic_") && column !== "total_duration_ms" && column !== "request_service_tier")].join(", ");
    old.exec(`ALTER TABLE model_request_metrics RENAME TO previous_metrics;
      ${modelRequestMetricsTableSql.replace(/,\n {4}traffic_label TEXT,[\s\S]*?\n {2}\);/u, "\n  );")}
      INSERT INTO model_request_metrics (${columns}) SELECT ${columns} FROM previous_metrics;
      DROP TABLE previous_metrics;
      UPDATE schema_metadata SET value = 16 WHERE name = 'schema_version';`);
    old.close();
    const result = upgradeMetricsDatabase(environment, { gatewayRunning: () => false });
    expect(result).toMatchObject({ changed: true, previousSchemaVersion: 16, schemaVersion: 19 });
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get()?.value).toBe(16);
    backup.close();
    const upgraded = new SqliteModelRequestMetricsStore(databasePath);
    expect(upgraded.recent(1)[0]).toMatchObject({ firstContentMs: 12.5, upstreamTtftMs: 672, requestModel: "sent", responseModel: "echoed", traffic: null });
    const traffic = { label: "openai", session: "2026-09-19T00-00-00-000Z-2", interaction: 3 };
    upgraded.record({ ...metricSample(), traffic });
    expect(upgraded.recent(1)[0]?.traffic).toEqual(traffic);
    upgraded.close();
  });
  it("preserves v15 upstream timing without fabricating per-request facts", () => {
    const { environment, databasePath } = fixture();
    const current = new SqliteModelRequestMetricsStore(databasePath);
    current.record({ ...metricSample(), upstreamTtftMs: 672 });
    current.close();
    const old = new DatabaseSync(databasePath);
    old.exec(`ALTER TABLE model_request_metrics DROP COLUMN first_content_ms;
      ALTER TABLE model_request_metrics DROP COLUMN request_model;
      ALTER TABLE model_request_metrics DROP COLUMN response_model;
      UPDATE schema_metadata SET value = 15 WHERE name = 'schema_version';`);
    old.close();
    expect(validateMetricsDatabaseStructure(environment, { allowUpgradeable: true }).schemaVersion).toBe(15);
    expect(upgradeMetricsDatabase(environment, { gatewayRunning: () => false }).schemaVersion).toBe(19);
    const upgraded = new SqliteModelRequestMetricsStore(databasePath);
    expect(upgraded.recent(1)[0]).toMatchObject({ upstreamTtftMs: 672, firstContentMs: null, requestModel: null, responseModel: null });
    upgraded.record({ ...metricSample(), firstContentMs: 12.5, requestModel: "a", responseModel: "b" });
    expect(upgraded.recent(1)[0]).toMatchObject({ firstContentMs: 12.5, requestModel: "a", responseModel: "b" });
    upgraded.close();
  });
  it("backs up v14 and preserves history with unknown TTFT on explicit upgrade", () => {
    const { environment, databasePath } = fixture();
    const current = new SqliteModelRequestMetricsStore(databasePath);
    current.recordBatch([metricSample(), metricSample()]);
    current.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`ALTER TABLE model_request_metrics DROP COLUMN upstream_ttft_ms;
      ALTER TABLE model_request_metrics DROP COLUMN first_content_ms;
      ALTER TABLE model_request_metrics DROP COLUMN request_model;
      ALTER TABLE model_request_metrics DROP COLUMN response_model;
      UPDATE schema_metadata SET value = 14 WHERE name = 'schema_version';`);
    legacy.close();
    expect(() => new SqliteModelRequestMetricsStore(databasePath)).toThrow(/版本不兼容/u);
    expect(() => validateMetricsDatabaseStructure(environment, { allowUpgradeable: true })).not.toThrow();
    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false, now: () => new Date("2026-09-18T00:00:00.000Z"),
    });
    expect(result).toMatchObject({ changed: true, previousSchemaVersion: 14, schemaVersion: 19 });
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get()?.value).toBe(14);
    expect(backup.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get()?.count).toBe(2);
    backup.close();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    expect(store.recent(10).map((row) => row.upstreamTtftMs)).toEqual([null, null]);
    store.record({ ...metricSample(), provider: "openai", upstreamTtftMs: 569.25 });
    expect(store.recent(1)[0]?.upstreamTtftMs).toBe(569.25);
    store.close();
    expect(upgradeMetricsDatabase(environment, { gatewayRunning: () => false }).changed).toBe(false);
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
    expect(columns.map((column) => column.name)).not.toContain("pricing_bucket");
    expect(columns.map((column) => column.name)).toContain("quota_windows");
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
    expect(columns.map((column) => column.name)).not.toContain("pricing_bucket");
    expect(columns.map((column) => column.name)).toContain("quota_windows");
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
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v10.2026-08-05T12-34-56-789Z.bak");
    if (process.platform !== "win32") expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    expect(upgraded.prepare(
      "SELECT value FROM schema_metadata WHERE name = 'schema_version'",
    ).get()).toEqual({ value: modelRequestMetricsSchemaVersion });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM model_request_metrics").get())
      .toEqual({ count: 1 });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM subagent_threads").get())
      .toEqual({ count: 1 });
    expect(upgraded.prepare("SELECT COUNT(*) AS count FROM subagent_turns").get())
      .toEqual({ count: 0 });
    upgraded.close();
  });

  it("backs up and rebuilds v13 as the current schema", () => {
    const { environment, databasePath } = fixture();
    const store = new SqliteModelRequestMetricsStore(databasePath);
    store.record({ ...metricSample(), userAgent: "codex-tui/0.154.0" });
    store.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      ALTER TABLE model_request_metrics ADD COLUMN billing_mode TEXT;
      ALTER TABLE model_request_metrics ADD COLUMN pricing_currency TEXT;
      ALTER TABLE model_request_metrics ADD COLUMN pricing_source TEXT;
      ALTER TABLE model_request_metrics ADD COLUMN pricing_effective_at_ms INTEGER;
      ALTER TABLE model_request_metrics ADD COLUMN pricing_bucket TEXT;
      ALTER TABLE model_request_metrics
        ADD COLUMN uncached_input_price_per_million_nanos INTEGER;
      ALTER TABLE model_request_metrics
        ADD COLUMN cached_input_price_per_million_nanos INTEGER;
      ALTER TABLE model_request_metrics ADD COLUMN output_price_per_million_nanos INTEGER;
      ALTER TABLE model_request_metrics ADD COLUMN upstream_created_at REAL;
      ALTER TABLE model_request_metrics ADD COLUMN upstream_completed_at REAL;
      ALTER TABLE model_request_metrics ADD COLUMN first_token_at_ms INTEGER;
      ALTER TABLE model_request_metrics ADD COLUMN first_reasoning_delta_at_ms INTEGER;
      ALTER TABLE model_request_metrics ADD COLUMN last_reasoning_delta_at_ms INTEGER;
      ALTER TABLE model_request_metrics ADD COLUMN first_output_delta_at_ms INTEGER;
      ALTER TABLE model_request_metrics ADD COLUMN last_output_delta_at_ms INTEGER;
      UPDATE model_request_metrics SET
        billing_mode = 'api',
        pricing_currency = 'USD',
        pricing_source = 'legacy',
        pricing_effective_at_ms = 1,
        pricing_bucket = 'peak',
        uncached_input_price_per_million_nanos = 1,
        cached_input_price_per_million_nanos = 1,
        output_price_per_million_nanos = 1,
        upstream_created_at = 1,
        upstream_completed_at = 2,
        first_token_at_ms = 1100,
        first_reasoning_delta_at_ms = 1100,
        last_reasoning_delta_at_ms = 1200,
        first_output_delta_at_ms = 1300,
        last_output_delta_at_ms = 1400;
      CREATE VIEW model_request_metrics_enriched AS
        SELECT *, 0 AS total_cost_nanos FROM model_request_metrics;
      UPDATE schema_metadata SET value = 13 WHERE name = 'schema_version';
    `);
    legacy.close();

    expect(() => validateMetricsDatabaseStructure(environment, {
      allowUpgradeable: true,
    })).not.toThrow();
    const result = upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-09-14T12:34:56.789Z"),
    });

    expect(result).toMatchObject({
      changed: true,
      previousSchemaVersion: 13,
      schemaVersion: modelRequestMetricsSchemaVersion,
    });
    expect(result.backupPath).toContain(".v13.2026-09-14T12-34-56-789Z.bak");
    if (process.platform !== "win32") {
      expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    }
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT billing_mode FROM model_request_metrics").get())
      .toEqual({ billing_mode: "api" });
    backup.close();

    const upgraded = new DatabaseSync(databasePath, { readOnly: true });
    const columns = upgraded.prepare("PRAGMA table_info(model_request_metrics)")
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(["id", ...metricStorageColumns]);
    expect(upgraded.prepare(`
      SELECT provider, input_tokens, user_agent FROM model_request_metrics
    `).get()).toEqual({
      provider: "deepseek",
      input_tokens: 1_000,
      user_agent: "codex-tui/0.154.0",
    });
    expect(upgraded.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'view' AND name = 'model_request_metrics_enriched'
    `).get()).toBeUndefined();
    upgraded.close();

    const resumed = new SqliteModelRequestMetricsStore(databasePath);
    resumed.record({ ...metricSample(), threadId: "thread-2", turnId: "turn-2" });
    resumed.close();
    const appended = new DatabaseSync(databasePath, { readOnly: true });
    expect(appended.prepare("SELECT id FROM model_request_metrics ORDER BY id").all())
      .toEqual([{ id: 1 }, { id: 2 }]);
    appended.close();
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
    if (process.platform !== "win32") expect(statSync(backupPath).mode & 0o777).toBe(0o600);
  });

  it("rolls back a v13 migration when account tables are malformed", () => {
    const { environment, databasePath } = fixture();
    createLegacyV6Database(databasePath, 1);
    const database = new DatabaseSync(databasePath);
    database.exec(`
      ALTER TABLE model_request_metrics ADD COLUMN pricing_bucket TEXT;
      ALTER TABLE model_request_metrics ADD COLUMN quota_windows TEXT;
      ALTER TABLE model_request_metrics ADD COLUMN user_agent TEXT;
      CREATE TABLE subagent_threads (
        thread_id TEXT PRIMARY KEY,
        parent_thread_id TEXT NOT NULL,
        parent_turn_id TEXT,
        agent_path TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      );
      CREATE TABLE subagent_turns (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        parent_turn_id TEXT NOT NULL,
        agent_path TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL,
        PRIMARY KEY (thread_id, turn_id)
      );
      CREATE INDEX subagent_turns_parent_turn
        ON subagent_turns (parent_thread_id, parent_turn_id);
      CREATE TABLE account_sources (source_id TEXT PRIMARY KEY);
      CREATE TABLE account_snapshots (snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT);
      UPDATE schema_metadata SET value = 13 WHERE name = 'schema_version';
    `);
    database.close();

    expect(() => upgradeMetricsDatabase(environment, {
      gatewayRunning: () => false,
      now: () => new Date("2026-09-14T13:45:00.000Z"),
    })).toThrow(/Schema 19 结构不完整/u);

    expect(inspectMetricsDatabase(environment).schemaVersion).toBe(13);
    expect(existsSync(
      `${databasePath}.v13.2026-09-14T13-45-00-000Z.bak`,
    )).toBe(true);
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
    })).toThrow(/仅支持 v3\/v4\/v5\/v6\/v7\/v8\/v9\/v10\/v11\/v12\/v13\/v14\/v15\/v16\/v17\/v18 升级到 v19/u);
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

});
