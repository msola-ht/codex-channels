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

export function createLegacyV3Database(path: string, count: number) {
  mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema_metadata (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO schema_metadata (name, value) VALUES ('schema_version', 3);
    CREATE TABLE model_request_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      billing_mode TEXT CHECK (
        billing_mode IS NULL OR billing_mode IN ('api', 'subscription', 'unknown')
      ),
      pricing_currency TEXT,
      pricing_source TEXT,
      pricing_effective_at_ms INTEGER,
      uncached_input_price_per_million_nanos INTEGER CHECK (
        uncached_input_price_per_million_nanos IS NULL
        OR uncached_input_price_per_million_nanos >= 0
      ),
      cached_input_price_per_million_nanos INTEGER CHECK (
        cached_input_price_per_million_nanos IS NULL
        OR cached_input_price_per_million_nanos >= 0
      ),
      output_price_per_million_nanos INTEGER CHECK (
        output_price_per_million_nanos IS NULL
        OR output_price_per_million_nanos >= 0
      ),
      transport TEXT NOT NULL CHECK (transport IN ('http', 'websocket')),
      response_format TEXT NOT NULL CHECK (
        response_format IN ('sse', 'json', 'websocket', 'unknown')
      ),
      operation TEXT NOT NULL CHECK (operation IN ('response', 'compact')),
      thread_id TEXT,
      turn_id TEXT,
      model TEXT,
      service_tier TEXT,
      reasoning_effort TEXT,
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'incomplete', 'unknown')),
      http_status INTEGER,
      error_type TEXT,
      error_code TEXT,
      incomplete_reason TEXT,
      input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      total_tokens INTEGER,
      upstream_created_at REAL,
      upstream_completed_at REAL,
      request_started_at_ms INTEGER NOT NULL,
      first_token_at_ms INTEGER,
      first_reasoning_delta_at_ms INTEGER,
      last_reasoning_delta_at_ms INTEGER,
      first_output_delta_at_ms INTEGER,
      last_output_delta_at_ms INTEGER,
      response_completed_at_ms INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      CHECK (
        (
          billing_mode IS NULL
          AND pricing_currency IS NULL
          AND pricing_source IS NULL
          AND pricing_effective_at_ms IS NULL
          AND uncached_input_price_per_million_nanos IS NULL
          AND cached_input_price_per_million_nanos IS NULL
          AND output_price_per_million_nanos IS NULL
        ) OR (
          billing_mode IS NOT NULL
          AND pricing_source IS NOT NULL
          AND pricing_effective_at_ms IS NOT NULL
          AND (
            (
              uncached_input_price_per_million_nanos IS NULL
              AND cached_input_price_per_million_nanos IS NULL
              AND output_price_per_million_nanos IS NULL
            ) OR pricing_currency IS NOT NULL
          )
        )
      )
    );
    CREATE INDEX model_request_metrics_recorded_at
      ON model_request_metrics (recorded_at_ms);
    CREATE INDEX model_request_metrics_thread_turn
      ON model_request_metrics (thread_id, turn_id, id);
    CREATE INDEX model_request_metrics_provider_model
      ON model_request_metrics (provider, model, id);
    CREATE VIEW model_request_metrics_enriched AS
      SELECT id, 0 AS total_cost_nanos FROM model_request_metrics;
  `);
  const insert = database.prepare(`
    INSERT INTO model_request_metrics (
      provider, transport, response_format, operation, status,
      request_started_at_ms, response_completed_at_ms, recorded_at_ms
    ) VALUES (?, 'http', 'sse', 'response', 'completed', ?, ?, ?)
  `);
  const nowMs = Date.now();
  for (let index = 0; index < count; index += 1) {
    insert.run("openai", nowMs, nowMs + 1, nowMs + 2);
  }
  database.close();
}

export function createLegacyV4Database(path: string, count: number) {
  createLegacyV3Database(path, count);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE model_request_metrics ADD COLUMN weekly_quota_limit_id TEXT
      CHECK (weekly_quota_limit_id IS NULL OR weekly_quota_limit_id = 'codex');
    ALTER TABLE model_request_metrics ADD COLUMN weekly_used_percent_millionths INTEGER
      CHECK (weekly_used_percent_millionths IS NULL
        OR weekly_used_percent_millionths BETWEEN 0 AND 100000000);
    ALTER TABLE model_request_metrics ADD COLUMN weekly_resets_at INTEGER
      CHECK (weekly_resets_at IS NULL OR weekly_resets_at >= 0);
    UPDATE schema_metadata SET value = 4 WHERE name = 'schema_version';
  `);
  database.close();
}

export function createLegacyV5Database(path: string, count: number) {
  createLegacyV4Database(path, count);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE model_request_metrics ADD COLUMN weekly_quota_plan_type TEXT;
    UPDATE schema_metadata SET value = 5 WHERE name = 'schema_version';
  `);
  database.close();
}

export function createLegacyV6Database(path: string, count: number) {
  createLegacyV5Database(path, count);
  const database = new DatabaseSync(path);
  database.exec(`
    ALTER TABLE model_request_metrics ADD COLUMN error_message TEXT;
    UPDATE schema_metadata SET value = 6 WHERE name = 'schema_version';
  `);
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
