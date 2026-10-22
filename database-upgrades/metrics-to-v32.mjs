import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, lstatSync, openSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const help = `Usage: node database-upgrades/metrics-to-v32.mjs REPOSITORY METRICS_DATABASE NEW_BACKUP_PATH

Manual, offline metrics database upgrade: schema 31 -> 32.
Requires Node.js with node:sqlite and current schema-32 dist/ (run npm run build first).
Stop Gateway and Model Relay and all other metrics writers before running; do not restart
until the command succeeds. This tool acquires Gateway's metrics writer lock.
The source must be a regular file, not a symbolic link. The backup must not exist;
its parent directory must be owned by the current user and not writable by others.
The full backup is created privately (0600) before the single upgrade transaction.
Existing rows, allocation high-water marks and all other tables are preserved.
Historical request_bytes values remain null because schema 31 did not record them.
Failure rolls back the transaction and retains a completed backup. For manual rollback,
keep all writers stopped and restore that backup, including removing stale SQLite
WAL/SHM sidecars before reopening. Never run this tool automatically at startup.
`;

const quote = name => '"' + name.replaceAll('"', '""') + '"';
const normalize = sql => sql?.replace(/\s+/gu, ' ').trim() ?? null;
const objects = database => database.prepare(`SELECT type, name, tbl_name, sql
  FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`).all()
  .map(row => ({ ...row, sql: normalize(row.sql) }));

function requireExactSchema(database, schema) {
  schema.requireCurrentModelRequestMetricsSchema(database);
  const reference = new DatabaseSync(':memory:');
  try {
    schema.ensureCurrentModelRequestMetricsSchema(reference);
    assert.deepEqual(objects(database), objects(reference), 'Source schema objects do not match the archived version');
  } finally {
    reference.close();
  }
}

function integrity(database, schema = 'main') {
  const results = database.prepare(`PRAGMA ${schema}.integrity_check`).all();
  if (results.length !== 1 || results[0].integrity_check !== 'ok') throw new Error('Database integrity check failed');
  if (database.prepare(`PRAGMA ${schema}.foreign_key_check`).all().length) throw new Error('Database foreign key check failed');
}

function preserveRows(database, tables) {
  for (const name of tables) {
    const table = quote(name);
    const columns = database.prepare(`PRAGMA original.table_info(${table})`).all().map(row => row.name);
    const filter = name === 'schema_metadata' ? " WHERE name <> 'schema_version'" : '';
    const projection = columns.map(quote).join(', ');
    const rows = schema => `SELECT ${projection} FROM ${schema}.${table}${filter}`;
    for (const [left, right] of [['main', 'original'], ['original', 'main']]) {
      if (database.prepare(`SELECT 1 FROM (${rows(left)} EXCEPT ${rows(right)}) LIMIT 1`).get()) {
        throw new Error(`Row preservation failed: ${name}`);
      }
    }
    const count = schema => database.prepare(`SELECT COUNT(*) AS count FROM ${schema}.${table}${filter}`).get().count;
    if (count('main') !== count('original')) throw new Error(`Row count changed: ${name}`);
  }
  assert.deepEqual(database.prepare('SELECT name, seq FROM main.sqlite_sequence ORDER BY name').all(),
    database.prepare('SELECT name, seq FROM original.sqlite_sequence ORDER BY name').all(),
    'Allocation high-water marks changed');
}

export async function upgradeMetrics(repository, databasePath, backupPath) {
  const source = resolve(databasePath);
  const backup = resolve(backupPath);
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error('Source must be a regular non-symbolic-link file');
  if (source === backup) throw new Error('Backup must differ from source');
  const parentStat = lstatSync(dirname(backup));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (process.getuid && parentStat.uid !== process.getuid()) || (parentStat.mode & 0o022)) {
    throw new Error('Backup parent must be an owned directory not writable by others');
  }
  const moduleUrl = name => pathToFileURL(resolve(repository, 'dist/observability', name)).href;
  const runtime = await import(moduleUrl('request-metrics-database.js'));
  const target = await import(moduleUrl('sqlite-request-metrics-schema.js'));
  if (runtime.modelRequestMetricsSchemaVersion !== 32) throw new Error('Current dist must use schema 32; build the current repository first');
  const lock = runtime.acquireRequestMetricsDatabaseLock(source);
  let database;
  let backupIdentity;
  let backupComplete = false;
  try {
    database = new DatabaseSync(source);
    database.exec('PRAGMA busy_timeout = 1000');
    const currentStat = lstatSync(source);
    if (currentStat.dev !== sourceStat.dev || currentStat.ino !== sourceStat.ino) throw new Error('Source changed during opening');
    const version = database.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get()?.value;
    if (version !== 31) throw new Error('Only source schema 31 is supported; no changes made');
    const historical = await import('./schema-v31.mjs');
    requireExactSchema(database, historical);
    integrity(database);
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(row => row.name);
    const metricColumns = database.prepare('PRAGMA table_info(model_request_metrics)').all().map(row => quote(row.name)).join(', ');
    const sequences = database.prepare('SELECT name, seq FROM sqlite_sequence').all();

    const backupFd = openSync(backup, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { backupIdentity = fstatSync(backupFd); } finally { closeSync(backupFd); }
    database.prepare('VACUUM INTO ?').run(backup);
    const savedStat = lstatSync(backup);
    if (savedStat.dev !== backupIdentity.dev || savedStat.ino !== backupIdentity.ino || (savedStat.mode & 0o777) !== 0o600) {
      throw new Error('Backup identity or permissions changed');
    }
    const saved = new DatabaseSync(backup, { readOnly: true });
    try { requireExactSchema(saved, historical); integrity(saved); } finally { saved.close(); }
    backupComplete = true;
    database.prepare('ATTACH DATABASE ? AS original').run(backup);
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec('ALTER TABLE model_request_metrics RENAME TO model_request_metrics_old');
      database.exec(target.modelRequestMetricsTableSql);
      database.exec(`INSERT INTO model_request_metrics (${metricColumns}) SELECT ${metricColumns} FROM model_request_metrics_old`);
      database.exec('DROP TABLE model_request_metrics_old');
      database.exec(target.modelRequestMetricsIndexesSql);
      database.exec("DELETE FROM sqlite_sequence WHERE name = 'model_request_metrics'");
      for (const row of sequences.filter(row => row.name === 'model_request_metrics')) {
        database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(row.name, row.seq);
      }
      database.exec("UPDATE schema_metadata SET value = 32 WHERE name = 'schema_version'");
      target.requireCurrentModelRequestMetricsSchema(database);
      preserveRows(database, tables);
      if (database.prepare('SELECT 1 FROM model_request_metrics WHERE request_bytes IS NOT NULL LIMIT 1').get()) {
        throw new Error('Historical request_bytes values must remain null');
      }
      integrity(database);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    return { upgraded: true, from: version, to: 32, preservedTables: tables.length, backup };
  } finally {
    try { database?.close(); } finally {
      try {
        if (backupIdentity && !backupComplete) {
          const current = lstatSync(backup, { throwIfNoEntry: false });
          if (current?.dev === backupIdentity.dev && current.ino === backupIdentity.ino) unlinkSync(backup);
        }
      } finally { lock.release(); }
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) {
    console.log(help);
  } else if (args.length !== 3 || args.some(arg => arg.startsWith('-'))) {
    console.error(help);
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(await upgradeMetrics(...args))); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
