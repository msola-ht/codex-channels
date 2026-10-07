import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { upgradeMetrics } from './metrics-to-v31.mjs';
import * as v28 from './schema-v28.mjs';
import * as v29 from './schema-v29.mjs';
import * as v30 from './schema-v30.mjs';
import { acquireRequestMetricsDatabaseLock } from '../dist/observability/request-metrics-database.js';
import { requireCurrentModelRequestMetricsSchema } from '../dist/observability/sqlite-request-metrics-schema.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const schemas = { 28: v28, 29: v29, 30: v30 };
const quote = name => '"' + name.replaceAll('"', '""') + '"';
function fixture(directory, version, name = 'metrics.sqlite3') {
  const path = join(directory, name);
  const db = new DatabaseSync(path);
  try {
    schemas[version].ensureCurrentModelRequestMetricsSchema(db);
    db.exec(`INSERT INTO schema_metadata VALUES ('fixture_metadata', 7);
      INSERT INTO model_request_metrics (id, provider, transport, response_format, operation, thread_id, turn_id,
        status, input_tokens, output_tokens, request_started_at_ms, response_completed_at_ms, recorded_at_ms)
        VALUES (17, 'fixture', 'http', 'sse', 'response', 'parent', 'turn', 'completed', 111, 22, 10, 20, 1000),
          (99, 'fixture', 'http', 'sse', 'response', 'deleted', 'turn', 'completed', 1, 1, 10, 20, 1000);
      DELETE FROM model_request_metrics WHERE id = 99;
      INSERT INTO account_sources VALUES ('account', 'fixture', 'actor', 'Fixture', 1);
      INSERT INTO account_snapshots VALUES (41, 'account', 1, 1, '{}', '{}'), (100, 'account', 2, 0, '{}', '{}');
      DELETE FROM account_snapshots WHERE snapshot_id = 100;
      INSERT INTO thread_execution_state VALUES ('parent', 'fixture', 1);
      INSERT INTO turn_execution_metrics VALUES ('parent', 'turn', 15, 1, 1000);
      INSERT INTO subagent_threads VALUES ('child', 'parent', 'turn', 'child', 1000);
      INSERT INTO subagent_turns VALUES ('child', 'child-turn', 'parent', 'turn', 'child', 1000);`);
    if (version >= 29) {
      db.exec("INSERT INTO auto_approval_review_turns VALUES ('parent', 'turn', 'fixture', 1, 1, 1, 1000)");
      const insert = version === 29
        ? 'INSERT INTO auto_approval_reviews VALUES (?, ?, ?, ?, ?, ?)'
        : 'INSERT INTO auto_approval_reviews VALUES (?, ?, ?, ?, ?, ?, ?)';
      const rows = [[0, 0, 'inProgress'], [1, 1, 'approved'], [1, 0, 'unknown']];
      if (version === 30) rows.push([1, 0, 'denied'], [1, 0, 'timedOut'], [1, 0, 'aborted']);
      rows.forEach(([completed, approved, status], index) => {
        const values = ['parent', 'turn', `review-${index}`, completed, approved];
        if (version === 30) values.push(status);
        db.prepare(insert).run(...values, 1000);
      });
    }
  } finally { db.close(); }
  return path;
}
function read(path, action) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return action(db); } finally { db.close(); }
}
function snapshot(path) {
  return read(path, db => ({
    schema: db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name').all(),
    rows: db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all()]),
  }));
}
function isolated(t) {
  const directory = mkdtempSync(join(tmpdir(), 'codexc-metrics-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function wrapperRepository(directory, schemaBody, lockBody = '') {
  const root = join(directory, 'wrapped-repository');
  mkdirSync(join(root, 'dist/observability'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const moduleUrl = name => pathToFileURL(join(repository, 'dist/observability', name)).href;
  writeFileSync(join(root, 'dist/observability/request-metrics-database.js'),
    `export * from ${JSON.stringify(moduleUrl('request-metrics-database.js'))};\n${lockBody}`);
  writeFileSync(join(root, 'dist/observability/sqlite-request-metrics-schema.js'),
    `export * from ${JSON.stringify(moduleUrl('sqlite-request-metrics-schema.js'))};\n${schemaBody}`);
  return root;
}

for (const version of [28, 29, 30]) {
  test(`schema ${version} upgrades directly to 31 with a private validated full backup`, async t => {
    const directory = isolated(t);
    const source = fixture(directory, version);
    const backup = join(directory, 'backup.sqlite3');
    const before = snapshot(source);
    const result = await upgradeMetrics(repository, source, backup);
    assert.equal(result.from, version);
    assert.equal(result.to, 31);
    assert.equal(statSync(backup).mode & 0o777, 0o600);
    assert.deepEqual(snapshot(backup), before);
    read(backup, db => schemas[version].requireCurrentModelRequestMetricsSchema(db));
    read(source, db => {
      requireCurrentModelRequestMetricsSchema(db);
      assert.deepEqual({ ...db.prepare('SELECT id, input_tokens, output_tokens, request_purpose, reviewer_thread_id, reviewer_turn_id FROM model_request_metrics').get() },
        { id: 17, input_tokens: 111, output_tokens: 22, request_purpose: null, reviewer_thread_id: null, reviewer_turn_id: null });
      assert.deepEqual(db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all().map(row => ({ ...row })),
        [{ name: 'account_snapshots', seq: 100 }, { name: 'model_request_metrics', seq: 99 }]);
      assert.equal(db.prepare('SELECT continuous FROM auto_approval_review_turns').get()?.continuous ?? 0, 0);
      const statuses = db.prepare('SELECT status FROM auto_approval_reviews ORDER BY review_id').all().map(row => row.status);
      assert.deepEqual(statuses, version === 28 ? [] : version === 29
        ? ['inProgress', 'approved', 'unknown'] : ['inProgress', 'approved', 'unknown', 'denied', 'timedOut', 'aborted']);
      for (const [name, rows] of before.rows) {
        if (['schema_metadata', 'sqlite_sequence', 'model_request_metrics', 'auto_approval_review_turns', 'auto_approval_reviews'].includes(name)) continue;
        assert.deepEqual(db.prepare(`SELECT * FROM ${quote(name)} ORDER BY rowid`).all(), rows);
      }
    });
    // Reusing a v31 input cannot generate another backup or modify any rows.
    const after = snapshot(source);
    const repeatBackup = join(directory, 'repeat.sqlite3');
    await assert.rejects(upgradeMetrics(repository, source, repeatBackup), /Only source schemas/);
    assert.equal(existsSync(repeatBackup), false);
    assert.deepEqual(snapshot(source), after);
    const writable = new DatabaseSync(source);
    try {
      writable.exec(`INSERT INTO model_request_metrics (provider, transport, response_format, operation, status,
        request_started_at_ms, response_completed_at_ms, recorded_at_ms)
        VALUES ('fixture', 'http', 'sse', 'response', 'completed', 1, 2, 3)`);
      assert.equal(writable.prepare('SELECT MAX(id) AS id FROM model_request_metrics').get().id, 100);
    } finally { writable.close(); }
  });
}

test('empty source keeps an empty allocation sequence and creates no historical review rows', async t => {
  const directory = isolated(t);
  for (const version of [28, 29, 30]) {
    const source = join(directory, `empty-${version}.sqlite3`);
    const db = new DatabaseSync(source);
    try { schemas[version].ensureCurrentModelRequestMetricsSchema(db); } finally { db.close(); }
    const backup = join(directory, `empty-${version}-backup.sqlite3`);
    await upgradeMetrics(repository, source, backup);
    read(source, current => {
      requireCurrentModelRequestMetricsSchema(current);
      assert.deepEqual(current.prepare('SELECT * FROM sqlite_sequence').all(), []);
      assert.equal(current.prepare('SELECT COUNT(*) AS count FROM auto_approval_reviews').get().count, 0);
    });
  }
});

test('CLI upgrades committed WAL data and produces a full standalone backup', t => {
  const directory = isolated(t);
  const source = fixture(directory, 30);
  const db = new DatabaseSync(source);
  try {
    db.exec("PRAGMA journal_mode = WAL; INSERT INTO schema_metadata VALUES ('wal_fixture', 101)");
    const before = snapshot(source);
    const backup = join(directory, 'backup.sqlite3');
    const cli = fileURLToPath(new URL('./metrics-to-v31.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, repository, source, backup], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).from, 30);
    assert.deepEqual(snapshot(backup), before);
    read(source, current => {
      requireCurrentModelRequestMetricsSchema(current);
      assert.equal(current.prepare("SELECT value FROM schema_metadata WHERE name = 'wal_fixture'").get().value, 101);
    });
  } finally { db.close(); }
});

test('invalid versions, missing tables, extra objects and altered constraints fail before backup or writes', async t => {
  const directory = isolated(t);
  for (const [name, alteration] of [
    ['version', 'UPDATE schema_metadata SET value = 999'],
    ['missing', 'DROP TABLE account_snapshots'],
    ['extra', 'CREATE TABLE unsupported (value TEXT)'],
    ['constraint', 'ALTER TABLE account_sources RENAME TO old_sources; CREATE TABLE account_sources (source_id TEXT PRIMARY KEY, provider TEXT NOT NULL, account_id TEXT, display_name TEXT NOT NULL, enabled INTEGER NOT NULL, UNIQUE (provider, account_id)); DROP TABLE old_sources'],
  ]) {
    const source = fixture(directory, 29, `${name}.sqlite3`);
    const db = new DatabaseSync(source);
    try { db.exec(alteration); } finally { db.close(); }
    const before = snapshot(source);
    const backup = join(directory, `${name}-backup.sqlite3`);
    await assert.rejects(upgradeMetrics(repository, source, backup));
    assert.equal(existsSync(backup), false);
    assert.deepEqual(snapshot(source), before);
  }
});

test('backup parent writable by others is rejected before touching the source', async t => {
  const directory = isolated(t);
  const source = fixture(directory, 28);
  const before = snapshot(source);
  const unsafe = join(directory, 'unsafe');
  mkdirSync(unsafe);
  chmodSync(unsafe, 0o777);
  const backup = join(unsafe, 'backup.sqlite3');
  await assert.rejects(upgradeMetrics(repository, source, backup), /not writable by others/);
  assert.equal(existsSync(backup), false);
  assert.deepEqual(snapshot(source), before);
});

test('held writer lock rejects upgrade without backup or source changes', async t => {
  const directory = isolated(t);
  const source = fixture(directory, 30);
  const before = snapshot(source);
  const backup = join(directory, 'backup.sqlite3');
  const lock = acquireRequestMetricsDatabaseLock(source);
  try { await assert.rejects(upgradeMetrics(repository, source, backup), { code: 'METRICS_DATABASE_LOCKED' }); }
  finally { lock.release(); }
  assert.equal(existsSync(backup), false);
  assert.deepEqual(snapshot(source), before);
});

test('existing backup, dangling backup symlink and symbolic source are rejected without overwrite', async t => {
  const directory = isolated(t);
  const source = fixture(directory, 28);
  const before = snapshot(source);
  const backup = join(directory, 'backup.sqlite3');
  writeFileSync(backup, 'preserve existing backup');
  await assert.rejects(upgradeMetrics(repository, source, backup), { code: 'EEXIST' });
  assert.equal(readFileSync(backup, 'utf8'), 'preserve existing backup');
  const dangling = join(directory, 'dangling');
  symlinkSync(join(directory, 'missing'), dangling);
  await assert.rejects(upgradeMetrics(repository, source, dangling), { code: 'EEXIST' });
  const link = join(directory, 'source-link');
  symlinkSync(source, link);
  await assert.rejects(upgradeMetrics(repository, link, join(directory, 'unused')), /regular non-symbolic-link/);
  assert.deepEqual(snapshot(source), before);
});

test('backup created concurrently during preparation is never overwritten', async t => {
  const directory = isolated(t);
  const source = fixture(directory, 29);
  const backup = join(directory, 'backup.sqlite3');
  const before = snapshot(source);
  const runtimeUrl = pathToFileURL(join(repository, 'dist/observability/request-metrics-database.js')).href;
  const root = wrapperRepository(directory, '', `import { writeFileSync } from 'node:fs';
    import { acquireRequestMetricsDatabaseLock as acquire } from ${JSON.stringify(runtimeUrl)};
    export function acquireRequestMetricsDatabaseLock(path) {
      const lock = acquire(path);
      writeFileSync(${JSON.stringify(backup)}, 'concurrent backup', { flag: 'wx' });
      return lock;
    }`);
  await assert.rejects(upgradeMetrics(root, source, backup), { code: 'EEXIST' });
  assert.equal(readFileSync(backup, 'utf8'), 'concurrent backup');
  assert.deepEqual(snapshot(source), before);
});

for (const version of [28, 29, 30]) {
  test(`post-write failure rolls back the entire schema ${version} transaction and keeps usable backup`, async t => {
    const directory = isolated(t);
    const source = fixture(directory, version);
    const before = snapshot(source);
    const backup = join(directory, 'backup.sqlite3');
    const root = wrapperRepository(directory,
      "export function requireCurrentModelRequestMetricsSchema() { throw new Error('fixture post-write validation failure'); }");
    await assert.rejects(upgradeMetrics(root, source, backup), /fixture post-write validation failure/);
    assert.deepEqual(snapshot(source), before);
    assert.deepEqual(snapshot(backup), before);
    read(source, db => schemas[version].requireCurrentModelRequestMetricsSchema(db));
    read(backup, db => schemas[version].requireCurrentModelRequestMetricsSchema(db));
    // A failed transaction also releases the writer lock.
    const lock = acquireRequestMetricsDatabaseLock(source);
    lock.release();
  });
}

test('CLI help explains offline use and supported versions; invalid arguments fail', () => {
  const cli = fileURLToPath(new URL('./metrics-to-v31.mjs', import.meta.url));
  for (const flag of ['-h', '--help']) {
    const result = spawnSync(process.execPath, [cli, flag], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /28, 29 or 30 -> 31/);
    assert.match(result.stdout, /Stop Gateway and Model Relay/);
    assert.match(result.stdout, /0600/);
  }
  assert.notEqual(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status, 0);
});
