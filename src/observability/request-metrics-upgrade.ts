import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, openSync, readSync, renameSync, statfsSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateFileAccessSync, securePrivateFileSync } from "../../runtime/private-file.mjs";
import { acquireRequestMetricsDatabaseLock } from "./request-metrics-database.js";
import { initialSchemaSql, metricStorageV20Columns, metricStorageColumns, modelRequestMetricsV21TableSql, modelRequestMetricsIndexesSql, modelRequestMetricsTableSql,
  modelRequestMetricsV20IndexesSql, modelRequestMetricsV20TableSql, relayMetricColumnDefinitions, relayMetricIndexesSql,
  requireCurrentModelRequestMetricsSchema, schemaMetadataSql } from "./sqlite-request-metrics-schema.js";

export interface MetricsUpgradeResult {
  from: 20 | 21;
  to: 22;
  changed: boolean;
  databasePath: string;
  backupPath: string | null;
  backupSha256: string | null;
}

// Observed v20 auxiliary data: preserve exactly, without making it a runtime feature.
const retainedCostsSql = `CREATE TABLE model_request_costs (
    metric_id INTEGER PRIMARY KEY,
    cost_usd_micros INTEGER NOT NULL CHECK (cost_usd_micros >= 0)
  )`;
function hasRetainedCosts(database: DatabaseSync): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_request_costs'").get() !== undefined;
}

/** Explicit offline operation. Runtime startup never invokes this function. */
export function upgradeRequestMetricsDatabase(path: string, apply = false, expectedFrom?: 20 | 21): MetricsUpgradeResult {
  const databasePath = resolve(path);
  assertPrivateFileAccessSync(databasePath);
  const lock = apply ? acquireRequestMetricsDatabaseLock(databasePath) : undefined;
  let database: DatabaseSync | undefined;
  let backup: { path: string; sha256: string } | undefined;
  try {
    database = new DatabaseSync(databasePath, { readOnly: !apply });
    const from = database.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get()?.value;
    if ((from !== 20 && from !== 21) || (expectedFrom !== undefined && from !== expectedFrom)) throw new Error("仅支持完整 v20/v21 指标库升级至 v22");
    requirePreviousSchema(database, from); integrity(database);
    const result: MetricsUpgradeResult = { from, to: 22, changed: false, databasePath, backupPath: null, backupSha256: null };
    if (!apply) return result;
    requireSnapshotSpace(databasePath);
    const original = logicalFingerprint(database);
    backup = snapshotDatabase(database, databasePath, `v${from}`);
    const preserved = new DatabaseSync(backup.path, { readOnly: true });
    try {
      requirePreviousSchema(preserved, from); integrity(preserved);
      if (logicalFingerprint(preserved) !== original) throw new Error("指标备份数据校验失败");
    } finally { preserved.close(); }
    database.exec("BEGIN IMMEDIATE");
    try {
      if (from === 20) {
        for (const column of relayMetricColumnDefinitions) database.exec(`ALTER TABLE model_request_metrics ADD COLUMN ${column}`);
        database.exec(relayMetricIndexesSql);
      } else {
        const sequence = database.prepare("SELECT seq FROM sqlite_sequence WHERE name='model_request_metrics'").get()?.seq;
        database.exec("ALTER TABLE model_request_metrics RENAME TO model_request_metrics_previous");
        database.exec(modelRequestMetricsTableSql);
        database.exec(`INSERT INTO model_request_metrics(id, ${metricStorageColumns.join(",")}) SELECT id, ${metricStorageColumns.join(",")} FROM model_request_metrics_previous`);
        database.exec("DROP TABLE model_request_metrics_previous");
        database.exec(modelRequestMetricsIndexesSql);
        database.prepare("DELETE FROM sqlite_sequence WHERE name='model_request_metrics'").run();
        if (sequence !== undefined) {
          database.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('model_request_metrics',?)").run(sequence);
        }
      }
      if (logicalFingerprint(database, from === 20) !== original) throw new Error("指标升级改变了历史数据");
      database.exec("UPDATE schema_metadata SET value = 22 WHERE name = 'schema_version'");
      requireCurrentModelRequestMetricsSchema(database); integrity(database);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    requireCurrentModelRequestMetricsSchema(database); integrity(database);
    return { ...result, changed: true, backupPath: backup.path, backupSha256: backup.sha256 };
  } catch (cause) {
    if (backup) throw new Error(`指标升级未完成；服务应保持停止。保留备份：${backup.path}；SHA-256：${backup.sha256}`, { cause });
    throw cause;
  } finally { database?.close(); lock?.release(); }
}

/** Archive v22 before restoring a verified previous snapshot; never silently discard new history. */
export function restoreRequestMetricsDatabase(path: string, backupPath: string, expectedSha256: string, to: 20 | 21): { archivedPath: string; archivedSha256: string } {
  const databasePath = resolve(path); const source = resolve(backupPath);
  if (databasePath === source || !/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error("指标回滚备份参数无效");
  assertPrivateFileAccessSync(databasePath); assertPrivateFileAccessSync(source);
  if (fileHash(source) !== expectedSha256) throw new Error("指标回滚备份摘要不匹配");
  const lock = acquireRequestMetricsDatabaseLock(databasePath);
  let database: DatabaseSync | undefined;
  const staged = `${databasePath}.restore-${randomUUID()}`;
  try {
    requireSnapshotSpace(databasePath, statSync(source).size);
    const backup = new DatabaseSync(source, { readOnly: true });
    try { requirePreviousSchema(backup, to); integrity(backup); } finally { backup.close(); }
    database = new DatabaseSync(databasePath);
    requireCurrentModelRequestMetricsSchema(database); integrity(database);
    const archive = snapshotDatabase(database, databasePath, "v22-rollback");
    const check = new DatabaseSync(archive.path, { readOnly: true });
    try { requireCurrentModelRequestMetricsSchema(check); integrity(check); } finally { check.close(); }
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0) throw new Error("指标回滚仍有活动数据库读取者");
    copyFileSync(source, staged, constants.COPYFILE_EXCL); securePrivateFileSync(staged);
    if (fileHash(staged) !== expectedSha256) throw new Error("指标回滚暂存备份摘要不匹配");
    database.close(); database = undefined;
    // All writers are excluded by the retained lock; truncate and close precede replacing the main file.
    for (const suffix of ["-wal", "-shm"]) if (existsSync(databasePath + suffix)) unlinkSync(databasePath + suffix);
    renameSync(staged, databasePath);
    return { archivedPath: archive.path, archivedSha256: archive.sha256 };
  } finally {
    database?.close(); lock.release();
    if (existsSync(staged)) unlinkSync(staged);
  }
}

function snapshotDatabase(database: DatabaseSync, path: string, label: string): { path: string; sha256: string } {
  const target = `${path}.${label}-${randomUUID()}.bak`;
  // Pre-create with private permissions. VACUUM INTO accepts only a nonexistent or empty file.
  const descriptor = openSync(target, "wx", 0o600); closeSync(descriptor); securePrivateFileSync(target);
  database.exec("PRAGMA synchronous = FULL");
  database.prepare("VACUUM INTO ?").run(target);
  return { path: target, sha256: fileHash(target) };
}
function requireSnapshotSpace(path: string, additionalBytes = 0): void {
  const space = statfsSync(dirname(path));
  const bytes = statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
  if (space.bavail * space.bsize < bytes * 3 + additionalBytes + 1024 * 1024) throw new Error("指标维护可用磁盘空间不足");
}
function integrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA integrity_check").all();
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") throw new Error("指标数据库完整性检查失败");
}
function requirePreviousSchema(database: DatabaseSync, version: 20 | 21): void {
  const expected = new DatabaseSync(":memory:");
  try {
    expected.exec(schemaMetadataSql + initialSchemaSql.replace(modelRequestMetricsTableSql, version === 20 ? modelRequestMetricsV20TableSql : modelRequestMetricsV21TableSql)
      .replace(modelRequestMetricsIndexesSql, version === 20 ? modelRequestMetricsV20IndexesSql : modelRequestMetricsIndexesSql).replace("'schema_version', 22", `'schema_version', ${version}`));
    if (hasRetainedCosts(database)) expected.exec(retainedCostsSql);
    const schema = (db: DatabaseSync): string => JSON.stringify(db.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    ).all().map(row => ({ ...row, sql: typeof row.sql === "string" ? row.sql.replace(/\s+/gu, " ").trim() : row.sql })));
    if (schema(database) !== schema(expected)
      || database.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get()?.value !== version) {
      throw new Error(`仅支持完整 v${version} 指标库的显式升级或恢复`);
    }
  } finally { expected.close(); }
}
function logicalFingerprint(database: DatabaseSync, migrated = false): string {
  const hash = createHash("sha256");
  const tables = ["schema_metadata", "account_sources", "account_snapshots", "subagent_threads", "subagent_turns", "model_request_metrics", "sqlite_sequence"];
  if (hasRetainedCosts(database)) tables.push("model_request_costs");
  for (const name of tables) {
    hash.update(name);
    const columns = migrated && name === "model_request_metrics" ? `id, ${metricStorageV20Columns.join(", ")}` : "*";
    const statement = database.prepare(`SELECT ${columns} FROM ${name} ORDER BY 1, 2`);
    for (const row of statement.iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
}
function fileHash(path: string): string {
  const hash = createHash("sha256"); const buffer = Buffer.alloc(1024 * 1024); const descriptor = openSync(path, "r");
  try {
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    return hash.digest("hex");
  } finally { closeSync(descriptor); }
}
