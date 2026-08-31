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
  it("fails closed when the standalone metrics schema version is unsupported", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "request-metrics.sqlite3");
    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO schema_metadata (name, value) VALUES ('schema_version', 99);
    `);
    database.close();

    expect(() => new SqliteModelRequestMetricsStore(path)).toThrow(
      /codexc metrics reset/u,
    );
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
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "codexc-request-metrics-schema-"));
  temporaryDirectories.push(directory);
  return directory;
}
