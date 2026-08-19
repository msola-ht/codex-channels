import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  metricsDimension,
  metricsRangeOptions,
  parseCleanupOptions,
  parseMetricsOptions,
  parseMetricsRunArgs,
  parseMetricsThreadsArgs,
  parseMetricsTurnsArgs,
  validateMetricsCommandArgs,
} from "../scripts/metrics-command-options.mjs";
import { primaryProviderBackupPath } from "../runtime/model-provider-runtime.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("metrics command options", () => {
  it("resolves explicit local date ranges without exceeding now", () => {
    const nowMs = new Date(2026, 7, 12, 12).getTime();

    expect(metricsRangeOptions({ from: "2026-08-10", to: "2026-08-12" }, nowMs))
      .toEqual({
        name: "2026-08-10..2026-08-12",
        startAtMs: new Date(2026, 7, 10).getTime(),
        endAtMs: nowMs,
      });
    expect(() => metricsRangeOptions({ from: "2026-08-10" }, nowMs))
      .toThrow("自定义日期必须同时使用 --from 和 --to");
  });

  it("parses shared report and cleanup options", () => {
    expect(parseMetricsOptions(
      ["--range", "7d", "--group", "providers"],
      new Set(["--range", "--group"]),
    )).toEqual({ range: "7d", group: "providers" });
    expect(metricsDimension("providers")).toBe("provider");
    expect(parseCleanupOptions(["--keep-days", "30", "--max-rows", "1000", "--vacuum"]))
      .toEqual({ keepDays: 30, maxRows: 1000, vacuum: true });
    expect(() => parseCleanupOptions(["--before", "2026-08-01", "--keep-days", "30"]))
      .toThrow("--before 与 --keep-days 不能同时使用");
  });

  it("keeps run and turns positional parsing aligned while preserving usage errors", () => {
    expect(parseMetricsRunArgs(["thread-1", "--format", "json"]))
      .toEqual({ threadId: "thread-1", format: "json" });
    expect(parseMetricsTurnsArgs(["thread-1", "--format", "csv"]))
      .toEqual({ threadId: "thread-1", format: "csv" });
    expect(() => parseMetricsRunArgs([])).toThrow("codexc metrics run <Thread ID>");
    expect(() => parseMetricsTurnsArgs([])).toThrow("codexc metrics turns <Thread ID>");
  });

  it("accepts only the documented threads formats", () => {
    expect(parseMetricsThreadsArgs([])).toEqual({ format: "markdown" });
    expect(parseMetricsThreadsArgs(["--format", "json"]))
      .toEqual({ format: "json" });
    expect(() => parseMetricsThreadsArgs(["thread-1"]))
      .toThrow("未知参数：thread-1");
  });

  it("accepts a configured custom primary Provider for prune", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-metrics-prune-custom-"));
    temporaryDirectories.push(codexHome);
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), [
      'model_provider = "OpenAI"',
      "",
      "[model_providers.OpenAI]",
      'base_url = "https://zzone.example.test/v1"',
      'wire_api = "responses"',
      "",
    ].join("\n"), { mode: 0o600 });
    const environment = { ...process.env, CODEX_HOME: codexHome };

    expect(() => validateMetricsCommandArgs("prune", ["OpenAI"], environment))
      .not.toThrow();
    expect(() => validateMetricsCommandArgs("prune", ["unknown"], environment))
      .toThrow("codexc metrics prune <openai|deepseek|opencode-go>");
  });

  it("accepts a backed-up custom primary Provider for prune", () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-metrics-prune-backup-"));
    temporaryDirectories.push(connectHome);
    const backupPath = primaryProviderBackupPath({ CODEX_CONNECT_HOME: connectHome });
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    writeFileSync(backupPath, JSON.stringify({
      OpenAI: {
        base_url: "https://zzone.example.test/v1",
        wire_api: "responses",
      },
    }), { mode: 0o600 });
    const environment = { ...process.env, CODEX_CONNECT_HOME: connectHome };

    expect(() => validateMetricsCommandArgs("prune", ["OpenAI"], environment))
      .not.toThrow();
    expect(() => validateMetricsCommandArgs("prune", ["unknown"], environment))
      .toThrow("codexc metrics prune <openai|deepseek|opencode-go>");
  });
});
