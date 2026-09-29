import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { securePrivateFileSync } from "../runtime/private-file.mjs";
import { SqliteModelRequestMetricsStore, upgradeRequestMetricsDatabase, restoreRequestMetricsV20, BufferedModelRequestMetricsWriter,
  type ModelRequestMetricSample } from "../src/observability/index.js";
import { initialSchemaSql, metricStorageV20Columns, modelRequestMetricsTableSql, modelRequestMetricsIndexesSql,
  modelRequestMetricsV20TableSql, modelRequestMetricsV20IndexesSql, schemaMetadataSql } from "../src/observability/sqlite-request-metrics-schema.js";
import { sample } from "./request-metrics-fixtures.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const relay = (): ModelRequestMetricSample => ({ ...sample(), source: "relay", threadId: null, turnId: null,
  callerId: "caller-a", keyId: "key-a", credentialGeneration: 1, relayRequestId: "47d8c4b4-03af-457e-857e-7ab710d55163", deliveryStatus: "finished" });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "relay-upgrade-")); roots.push(root);
  const path = join(root, "metrics.sqlite3"); const database = new DatabaseSync(path); securePrivateFileSync(path);
  database.exec(schemaMetadataSql + initialSchemaSql.replace(modelRequestMetricsTableSql, modelRequestMetricsV20TableSql)
    .replace(modelRequestMetricsIndexesSql, modelRequestMetricsV20IndexesSql).replace("'schema_version', 21", "'schema_version', 20"));
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`INSERT INTO model_request_metrics(provider, transport, response_format, operation, status,
    request_started_at_ms, response_completed_at_ms, recorded_at_ms, input_tokens, first_token_ms, total_duration_ms)
    VALUES('clp-a', 'http', 'json', 'response', 'completed', 1, 2, ${Date.now()}, 7, 0.5, 1)`);
  const row = database.prepare("SELECT * FROM model_request_metrics").get(); database.close();
  return { path, root, row };
}
describe("explicit Relay metrics upgrade", () => {
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
    const restored = restoreRequestMetricsV20(path, result.backupPath!, result.backupSha256!);
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
    expect(upgradeRequestMetricsDatabase(path)).toMatchObject({ changed: false, from: 20, to: 21, backupPath: null });
    expect(readFileSync(path)).toEqual(bytes);
    const result = upgradeRequestMetricsDatabase(path, true);
    expect(result.changed).toBe(true); expect(result.backupSha256).toMatch(/^[a-f0-9]{64}$/u);
    const backup = new DatabaseSync(result.backupPath!, { readOnly: true });
    expect(backup.prepare("SELECT * FROM model_request_metrics").get()).toEqual(row); backup.close();
    const upgraded = new DatabaseSync(path, { readOnly: true });
    expect(upgraded.prepare(`SELECT id, ${metricStorageV20Columns.join(", ")} FROM model_request_metrics`).get()).toEqual(row);
    expect(upgraded.prepare("SELECT source, caller_id, delivery_status FROM model_request_metrics").get()).toEqual({ source: "owned", caller_id: null, delivery_status: null });
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
  it.each([1, 2, 3, 4, 5, 6, 7])("rolls back after DDL cut %s and preserves a readable v20 backup", cut => {
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
    expect(() => restoreRequestMetricsV20(path, result.backupPath!, "0".repeat(64))).toThrow("摘要");
    const restored = restoreRequestMetricsV20(path, result.backupPath!, result.backupSha256!);
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
