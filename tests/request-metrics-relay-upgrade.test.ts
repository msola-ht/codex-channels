import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { securePrivateFileSync } from "../runtime/private-file.mjs";
import { SqliteModelRequestMetricsStore, upgradeRequestMetricsDatabase, restoreRequestMetricsDatabase, BufferedModelRequestMetricsWriter,
  type ModelRequestMetricSample } from "../src/observability/index.js";
import { initialSchemaSql, turnExecutionSchemaSql, quotaObservedAtColumn, relayMetricColumnDefinitions, relayMetricIndexesSql, metricStorageV20Columns, modelRequestMetricsTableSql, modelRequestMetricsIndexesSql,
  modelRequestMetricsV25TableSql, modelRequestMetricsV24TableSql, modelRequestMetricsV23TableSql, modelRequestMetricsV21TableSql, modelRequestMetricsV22TableSql, modelRequestMetricsV20TableSql, modelRequestMetricsV20IndexesSql, schemaMetadataSql } from "../src/observability/sqlite-request-metrics-schema.js";
import { sample } from "./request-metrics-fixtures.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const relay = (): ModelRequestMetricSample => ({ ...sample(), source: "relay", threadId: null, turnId: null,
  callerId: "caller-a", keyId: "key-a", credentialGeneration: 1, relayRequestId: "47d8c4b4-03af-457e-857e-7ab710d55163", deliveryStatus: "finished" });

it("preserves v26 timing facts and historical quota snapshots without fabricating observation times", () => {
  const { path } = fixture(26);
  const old = new DatabaseSync(path);
  old.exec(`INSERT INTO thread_execution_state VALUES ('thread', 'openai', 1);
    INSERT INTO turn_execution_metrics VALUES ('thread', 'turn', 71000, 0, 2000);
    UPDATE model_request_metrics SET weekly_quota_limit_id='codex', weekly_used_percent_millionths=1000000,
      weekly_resets_at=2000000000, weekly_quota_plan_type='plus', response_usage_amount='0.0123',
      upstream_provider='openai', upstream_attempt_count=2, finish_reason='stop'`);
  const row = old.prepare("SELECT * FROM model_request_metrics").get();
  const timing = old.prepare("SELECT * FROM turn_execution_metrics").get();
  const state = old.prepare("SELECT * FROM thread_execution_state").get();
  old.close();
  expect(() => new SqliteModelRequestMetricsStore(path, undefined, { readOnly: true })).toThrow("--from 26 --to 27");
  const bytes = readFileSync(path);
  expect(upgradeRequestMetricsDatabase(path, false, 26)).toMatchObject({ from: 26, to: 27, changed: false });
  expect(readFileSync(path)).toEqual(bytes);
  const result = upgradeRequestMetricsDatabase(path, true, 26);
  expect(createHash("sha256").update(readFileSync(result.backupPath!)).digest("hex")).toBe(result.backupSha256);
  const current = new DatabaseSync(path);
  expect(current.prepare("SELECT * FROM model_request_metrics").get()).toEqual({ ...row, quota_observed_at_ms: null });
  expect(current.prepare("SELECT * FROM turn_execution_metrics").get()).toEqual(timing);
  expect(current.prepare("SELECT * FROM thread_execution_state").get()).toEqual(state);
  for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "invalid"]) {
    expect(() => current.prepare("UPDATE model_request_metrics SET quota_observed_at_ms=?").run(invalid)).toThrow();
  }
  current.prepare("UPDATE model_request_metrics SET quota_observed_at_ms=?").run(1234);
  current.close();
  const restored = restoreRequestMetricsDatabase(path, result.backupPath!, result.backupSha256!, 26);
  expect(createHash("sha256").update(readFileSync(restored.archivedPath)).digest("hex")).toBe(restored.archivedSha256);
  const archive = new DatabaseSync(restored.archivedPath, { readOnly: true });
  expect(archive.prepare("SELECT quota_observed_at_ms FROM model_request_metrics").get()?.quota_observed_at_ms).toBe(1234);
  archive.close();
  const restoredDatabase = new DatabaseSync(path, { readOnly: true });
  expect(restoredDatabase.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row);
  expect(restoredDatabase.prepare("SELECT * FROM turn_execution_metrics").get()).toEqual(timing);
  expect(restoredDatabase.prepare("SELECT * FROM thread_execution_state").get()).toEqual(state);
  restoredDatabase.close();
});

it.each(["column", "version"] as const)("rolls back interrupted v26 quota observation migration after %s", cut => {
  const { path, row } = fixture(26);
  const execute = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    execute.call(this, sql);
    if (cut === "column" && sql === `ALTER TABLE model_request_metrics ADD COLUMN ${quotaObservedAtColumn}`
      || cut === "version" && sql === "UPDATE schema_metadata SET value = 27 WHERE name = 'schema_version'") {
      throw new Error("fixture quota migration failure");
    }
  });
  try { expect(() => upgradeRequestMetricsDatabase(path, true, 26)).toThrow("保留备份"); }
  finally { spy.mockRestore(); }
  const old = new DatabaseSync(path, { readOnly: true });
  expect(old.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row);
  expect(old.prepare("SELECT value FROM schema_metadata WHERE name='schema_version'").get()?.value).toBe(26);
  old.close();
  expect(upgradeRequestMetricsDatabase(path, true, 26).changed).toBe(true);
});

it("rolls back a failed v25 timing-table migration and archives new timing facts before restoring v25", () => {
  const { path, row } = fixture(25);
  const execute = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    execute.call(this, sql);
    if (sql === turnExecutionSchemaSql) throw new Error("fixture timing migration failure");
  });
  try { expect(() => upgradeRequestMetricsDatabase(path, true, 25)).toThrow("保留备份"); }
  finally { spy.mockRestore(); }
  const old = new DatabaseSync(path);
  expect(old.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row);
  expect(old.prepare("SELECT name FROM sqlite_master WHERE name = 'turn_execution_metrics'").get()).toBeUndefined();
  old.close();
  const result = upgradeRequestMetricsDatabase(path, true, 25);
  const store = new SqliteModelRequestMetricsStore(path);
  store.replaceThreadExecutions("thread", "openai", [{ turnId: "turn", durationMs: 71_000, recordedAtMs: Date.now() }]);
  store.close();
  const restored = restoreRequestMetricsDatabase(path, result.backupPath!, result.backupSha256!, 25);
  const archive = new SqliteModelRequestMetricsStore(restored.archivedPath, undefined, { readOnly: true });
  expect(archive.sessionExecutionDuration("thread")).toBe(71_000); archive.close();
});
function fixture(version: 20 | 21 | 22 | 23 | 24 | 25 | 26 = 20) {
  const root = mkdtempSync(join(tmpdir(), "relay-upgrade-")); roots.push(root);
  const path = join(root, "metrics.sqlite3"); const database = new DatabaseSync(path); securePrivateFileSync(path);
  database.exec(schemaMetadataSql + initialSchemaSql.replace(turnExecutionSchemaSql, version === 26 ? turnExecutionSchemaSql : "").replace(modelRequestMetricsTableSql, version === 20 ? modelRequestMetricsV20TableSql : version === 21 ? modelRequestMetricsV21TableSql : version === 22 ? modelRequestMetricsV22TableSql : version === 23 ? modelRequestMetricsV23TableSql : version === 24 ? modelRequestMetricsV24TableSql : modelRequestMetricsV25TableSql)
    .replace(modelRequestMetricsIndexesSql, version === 20 ? modelRequestMetricsV20IndexesSql : modelRequestMetricsIndexesSql).replace("'schema_version', 27", `'schema_version', ${version}`));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`INSERT INTO model_request_metrics(provider, transport, response_format, operation, status,
    request_started_at_ms, response_completed_at_ms, recorded_at_ms, input_tokens, first_token_ms, total_duration_ms)
    VALUES('clp-a', 'http', 'json', 'response', 'completed', 1, 2, ${Date.now()}, 7, 0.5, 1)`);
  const row = database.prepare("SELECT * FROM model_request_metrics").get(); database.close();
  return { path, root, row };
}
describe("explicit Relay metrics upgrade", () => {
  it.each(([21, 23, 24] as const).flatMap(version => [1, 2, 3, 4, 5, 6].map(cut => ({ version, cut }))))("rolls back interrupted v$version table rebuild at step $cut", ({ version, cut }) => {
    const { path, root, row } = fixture(version);
    const execute = DatabaseSync.prototype.exec; let active = false; let step = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith("ALTER TABLE model_request_metrics RENAME")) active = true;
      execute.call(this, sql);
      if (active && sql !== "ROLLBACK" && ++step === cut) throw new Error("fixture interruption");
    });
    try { expect(() => upgradeRequestMetricsDatabase(path, true, version)).toThrow("保留备份"); } finally { spy.mockRestore(); }
    const db = new DatabaseSync(path);
    expect(db.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row);
    expect(db.prepare("SELECT value FROM schema_metadata WHERE name='schema_version'").get()?.value).toBe(version); db.close();
    expect(readdirSync(root).filter(name => name.endsWith(".bak"))).toHaveLength(1);
    expect(upgradeRequestMetricsDatabase(path, true, version).changed).toBe(true);
  });
  it.each([21, 22, 23] as const)("accepts v%s produced by the historical ALTER upgrade, including an empty metrics table", version => {
    const { path } = fixture();
    const db = new DatabaseSync(path);
    for (const column of relayMetricColumnDefinitions) db.exec(`ALTER TABLE model_request_metrics ADD COLUMN ${column.replace("AND (traffic_label IS NULL OR traffic_label IN ('relay.chat', 'relay.responses'))", version === 21 ? "AND traffic_label IS NULL AND traffic_session IS NULL AND traffic_interaction IS NULL" : version === 22 ? "AND (traffic_label IS NULL OR traffic_label = 'relay.chat')" : "AND (traffic_label IS NULL OR traffic_label IN ('relay.chat', 'relay.responses'))")}`);
    db.exec(relayMetricIndexesSql);
    db.exec(`UPDATE schema_metadata SET value=${version} WHERE name='schema_version'; DELETE FROM model_request_metrics`); db.close();
    expect(upgradeRequestMetricsDatabase(path, true, version).changed).toBe(true);
    const current = new DatabaseSync(path);
    expect(current.prepare("SELECT seq FROM sqlite_sequence WHERE name='model_request_metrics'").get()?.seq).toBe(1); current.close();
  });
  it("upgrades a v21 metrics table that has never allocated a sequence", () => {
    const { path } = fixture(21); const db = new DatabaseSync(path);
    db.exec("DELETE FROM model_request_metrics; DELETE FROM sqlite_sequence WHERE name='model_request_metrics'"); db.close();
    expect(upgradeRequestMetricsDatabase(path, true, 21).changed).toBe(true);
    const current = new DatabaseSync(path);
    expect(current.prepare("SELECT seq FROM sqlite_sequence WHERE name='model_request_metrics'").get()).toBeUndefined(); current.close();
  });
  it.each([21, 22, 23, 24, 25, 26] as const)("upgrades v%s, preserves deleted sequence IDs and archives Relay dumps on rollback", version => {
    const { path } = fixture(version);
    const previous = new DatabaseSync(path);
    previous.exec("UPDATE sqlite_sequence SET seq=100 WHERE name='model_request_metrics'"); previous.close();
    const result = upgradeRequestMetricsDatabase(path, true, version);
    const store = new SqliteModelRequestMetricsStore(path);
    store.record({ ...relay(), responseUsageAmount: "0.12345678901234567890", traffic: { label: "relay.responses", session: "2026-09-29T00-00-00-000Z", interaction: 1 } });
    store.close();
    const current = new DatabaseSync(path);
    expect(current.prepare("SELECT quota_observed_at_ms FROM model_request_metrics WHERE source='owned'").get()?.quota_observed_at_ms).toBeNull();
    expect(current.prepare("SELECT response_usage_amount FROM model_request_metrics WHERE source='owned'").get()?.response_usage_amount).toBeNull();
    expect(current.prepare("SELECT response_usage_amount FROM model_request_metrics WHERE source='relay'").get()?.response_usage_amount).toBe("0.12345678901234567890");
    expect(current.prepare("SELECT id, traffic_label FROM model_request_metrics WHERE source='relay'").get()).toEqual({ id: 101, traffic_label: "relay.responses" });
    expect(() => current.exec("UPDATE model_request_metrics SET traffic_label='forged' WHERE source='relay'")).toThrow();
    current.close();
    const restored = restoreRequestMetricsDatabase(path, result.backupPath!, result.backupSha256!, version);
    const archive = new DatabaseSync(restored.archivedPath, { readOnly: true });
    expect(archive.prepare("SELECT count(*) AS n FROM model_request_metrics").get()?.n).toBe(2); archive.close();
    const old = new DatabaseSync(path, { readOnly: true });
    expect(old.prepare("SELECT value FROM schema_metadata WHERE name='schema_version'").get()?.value).toBe(version); old.close();
  });

  it("preserves the exact observed v20 costs table through backup, upgrade and rollback", () => {
    const { path } = fixture();
    const database = new DatabaseSync(path);
    database.exec(`CREATE TABLE model_request_costs (
    metric_id INTEGER PRIMARY KEY,
    cost_usd_micros INTEGER NOT NULL CHECK (cost_usd_micros >= 0)
  ); INSERT INTO model_request_costs VALUES (1, 123456)`);
    database.close();
    const readCosts = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true });
      try { return db.prepare("SELECT * FROM model_request_costs").all(); } finally { db.close(); }
    };
    const before = readCosts(path);
    expect(upgradeRequestMetricsDatabase(path).changed).toBe(false);
    const result = upgradeRequestMetricsDatabase(path, true);
    expect(readCosts(path)).toEqual(before); expect(readCosts(result.backupPath!)).toEqual(before);
    const store = new SqliteModelRequestMetricsStore(path); store.record(relay()); store.close();
    const restored = restoreRequestMetricsDatabase(path, result.backupPath!, result.backupSha256!, 20);
    expect(readCosts(restored.archivedPath)).toEqual(before); expect(readCosts(path)).toEqual(before);
  });
  it.each([
    "CREATE TABLE unrelated (id INTEGER)",
    "CREATE TABLE model_request_costs (metric_id INTEGER PRIMARY KEY, cost_usd_micros INTEGER NOT NULL)",
    `CREATE TABLE model_request_costs (metric_id INTEGER PRIMARY KEY, cost_usd_micros INTEGER NOT NULL CHECK (cost_usd_micros >= 0));
     CREATE TRIGGER costs_trigger AFTER INSERT ON model_request_costs BEGIN DELETE FROM model_request_metrics; END`,
  ])("rejects unsupported auxiliary structures: %s", sql => {
    const { path, root } = fixture(); const db = new DatabaseSync(path); db.exec(sql); db.close();
    expect(() => upgradeRequestMetricsDatabase(path, true)).toThrow("完整 v20");
    expect(readdirSync(root).filter(name => name.endsWith(".bak"))).toEqual([]);
  });
  it("previews without changing bytes, preserves historical columns and makes a readable private backup", () => {
    const { path, row } = fixture(); const bytes = readFileSync(path);
    expect(upgradeRequestMetricsDatabase(path)).toMatchObject({ changed: false, from: 20, to: 27, backupPath: null });
    expect(readFileSync(path)).toEqual(bytes);
    const result = upgradeRequestMetricsDatabase(path, true);
    expect(result.changed).toBe(true); expect(result.backupSha256).toMatch(/^[a-f0-9]{64}$/u);
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row); backup.close();
    const upgraded = new DatabaseSync(path, { readOnly: true });
    expect(upgraded.prepare(`SELECT id, ${metricStorageV20Columns.join(", ")} FROM model_request_metrics`).get()).toEqual(row);
    expect(upgraded.prepare("SELECT source, caller_id, delivery_status FROM model_request_metrics").get()).toEqual({ source: "owned", caller_id: null, delivery_status: null });
    expect(upgraded.prepare("SELECT quota_observed_at_ms FROM model_request_metrics").get()?.quota_observed_at_ms).toBeNull();
    upgraded.close();
  });
  it("deduplicates only Relay IDs without losing owned rows in the same batch", () => {
    const { path } = fixture(); upgradeRequestMetricsDatabase(path, true);
    const store = new SqliteModelRequestMetricsStore(path);
    try {
      store.recordBatch([relay(), { ...relay(), inputTokens: 9999 }, sample()]);
      expect(store.count()).toBe(3);
      const rows = store.page({ startAtMs: 0, endAtMs: Date.now() + 1000, source: "relay", callerId: "caller-a", limit: 10 });
      expect(rows.records).toHaveLength(1); expect(rows.records[0]).toMatchObject({ inputTokens: 1000, threadId: null, callerId: "caller-a" });
      expect(() => store.record({ ...relay(), relayRequestId: "57d8c4b4-03af-457e-857e-7ab710d55163", threadId: "forged" })).toThrow();
      expect(() => store.record({ ...sample(), callerId: "forged" })).toThrow();
      expect(() => store.record({ ...relay(), relayRequestId: "not-a-uuid" })).toThrow("请求 ID");
    } finally { store.close(); }
  });
  it("rejects unknown and incomplete schemas without attempting repair", () => {
    const { path, root } = fixture(); const db = new DatabaseSync(path);
    db.exec("DROP INDEX model_request_metrics_thread_turn"); db.close();
    expect(() => upgradeRequestMetricsDatabase(path, true)).toThrow("完整 v20");
    expect(readdirSync(root).filter(name => name.endsWith(".bak"))).toEqual([]);
  });
  it.each([1, 2, 3, 4, 5, 6, 7, 8])("rolls back after DDL cut %s and preserves a readable v20 backup", cut => {
    const { path, root, row } = fixture();
    const execute = DatabaseSync.prototype.exec; let steps = 0;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      execute.call(this, sql);
      if ((sql.startsWith("ALTER TABLE") || sql.includes("CREATE UNIQUE INDEX model_request_metrics_relay_request")) && ++steps === cut) {
        throw new Error("fixture interruption");
      }
    });
    try { expect(() => upgradeRequestMetricsDatabase(path, true)).toThrow("保留备份"); } finally { spy.mockRestore(); }
    const preserved = new DatabaseSync(path, { readOnly: true });
    expect(preserved.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row);
    expect(preserved.prepare("SELECT value FROM schema_metadata WHERE name='schema_version'").get()?.value).toBe(20); preserved.close();
    const backups = readdirSync(root).filter(name => name.endsWith(".bak")); expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(root, backups[0]!), { readOnly: true });
    expect(backup.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row); backup.close();
    expect(upgradeRequestMetricsDatabase(path, true).changed).toBe(true);
    const reopened = new SqliteModelRequestMetricsStore(path);
    try { expect(reopened.count()).toBe(1); } finally { reopened.close(); }
  });
  it("preserves the upgraded archive and restores only the verified v20 snapshot", () => {
    const { path, row } = fixture(); const result = upgradeRequestMetricsDatabase(path, true);
    const store = new SqliteModelRequestMetricsStore(path); store.record(relay()); store.close();
    expect(() => restoreRequestMetricsDatabase(path, result.backupPath!, "0".repeat(64), 20)).toThrow("摘要");
    const restored = restoreRequestMetricsDatabase(path, result.backupPath!, result.backupSha256!, 20);
    const archive = new DatabaseSync(restored.archivedPath, { readOnly: true });
    expect(archive.prepare("SELECT count(*) AS count FROM model_request_metrics").get()?.count).toBe(2); archive.close();
    const old = new DatabaseSync(path, { readOnly: true });
    expect(old.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row); old.close();
    expect(() => new SqliteModelRequestMetricsStore(path)).toThrow("metrics upgrade");
  });
  it("keeps capacity for owned metrics when Relay fills its share", async () => {
    const written: ModelRequestMetricSample[] = [];
    const writer = new BufferedModelRequestMetricsWriter({ record: value => { written.push(value); }, close: () => {}, recordSubagentThread: () => {}, recordSubagentTurn: () => {} });
    for (let index = 0; index < 256; index++) writer.enqueue(relay());
    expect(() => writer.enqueue(relay())).toThrow("Relay");
    writer.enqueue(sample()); await writer.close();
    expect(written).toHaveLength(257); expect(written.at(-1)?.source).toBeUndefined();
  });
});


it("preserves v24 amounts, initializes empty diagnostic columns and archives new facts before rollback", () => {
  const { path } = fixture(24);
  const previous = new DatabaseSync(path);
  previous.exec("UPDATE model_request_metrics SET response_usage_amount='0.12345678901234567890'"); previous.close();
  const result = upgradeRequestMetricsDatabase(path, true, 24);
  const store = new SqliteModelRequestMetricsStore(path);
  expect(store.requestRowsAfter(0, 10)[0]).toMatchObject({ responseUsageAmount: "0.12345678901234567890", upstreamProvider: null, finishReason: null });
  store.record({ ...relay(), upstreamProvider: "deepseek", upstreamAttemptCount: 2 }); store.close();
  const restored = restoreRequestMetricsDatabase(path, result.backupPath!, result.backupSha256!, 24);
  const archive = new SqliteModelRequestMetricsStore(restored.archivedPath, Date.now(), { readOnly: true });
  expect(archive.requestRowsAfter(0, 10)[1]).toMatchObject({ upstreamProvider: "deepseek", upstreamAttemptCount: 2 }); archive.close();
  const old = new DatabaseSync(path);
  expect(old.prepare("SELECT response_usage_amount FROM model_request_metrics").get()?.response_usage_amount).toBe("0.12345678901234567890");
  expect(old.prepare("SELECT value FROM schema_metadata WHERE name='schema_version'").get()?.value).toBe(24); old.close();
});
