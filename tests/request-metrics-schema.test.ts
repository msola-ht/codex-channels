import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SqliteModelRequestMetricsStore,
} from "../src/observability/index.js";
import { DatabaseSync } from "node:sqlite";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("request metrics schema", () => {
  it.each([19, 27, 28, 29, 99])("fails closed for metrics schema %s without rewriting history", (version) => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_metadata (name, value) VALUES ('schema_version', ${version});
    `);
    database.close();

    expect(() => new SqliteModelRequestMetricsStore(path)).toThrow(
      /核对数据库版本及备份，勿删除数据库/u,
    );
    const preserved = new DatabaseSync(path, { readOnly: true });
    expect(preserved.prepare("SELECT value FROM schema_metadata WHERE name = 'schema_version'").get()?.value).toBe(version);
    preserved.close();
  });

  it("rolls back an interrupted first schema initialization", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TRIGGER reject_schema_version
      BEFORE INSERT ON schema_metadata
      BEGIN
        SELECT RAISE(ABORT, 'schema version rejected');
      END;
    `);
    database.close();

    expect(() => new SqliteModelRequestMetricsStore(path)).toThrow(
      /schema version rejected/u,
    );

    const inspection = new DatabaseSync(path, { readOnly: true });
    const modelTable = inspection.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'model_request_metrics'
    `).get();
    inspection.close();
    expect(modelTable).toBeUndefined();
  });

  it("rejects incomplete review tables without recreating them", () => {
    const path = join(temporaryDirectory(), "request-metrics.sqlite3");
    const store = new SqliteModelRequestMetricsStore(path); store.close();
    const database = new DatabaseSync(path);
    database.exec("DROP TABLE auto_approval_reviews"); database.close();
    expect(() => new SqliteModelRequestMetricsStore(path)).toThrow(/结构不完整/u);
    const preserved = new DatabaseSync(path, { readOnly: true });
    expect(preserved.prepare("SELECT name FROM sqlite_master WHERE name = 'auto_approval_reviews'").get()).toBeUndefined();
    preserved.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-schema-"));
  temporaryDirectories.push(directory);
  return directory;
}
