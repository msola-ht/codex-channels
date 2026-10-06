import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { initializeUserData } from "../scripts/runtime-config.mjs";
import {
  requestMetricsDatabasePath,
  type ModelRequestMetricSample,
} from "../src/observability/index.js";

export function cleanupMetricsDatabaseTestFixtures(temporaryDirectories: string[]) {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function createMetricsDatabaseTestFixture(temporaryDirectories: string[]) {
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

export function createMetricsDatabase(path: string, schemaVersion: number, count: number) {
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

export function metricSample(): ModelRequestMetricSample {
  return {
    provider: "deepseek",
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
    errorMessage: null,
    incompleteReason: null,
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 1_100,
    requestStartedAtMs: 1_000,
    responseCompletedAtMs: 1_650,
    weeklyQuota: null,
  };
}
