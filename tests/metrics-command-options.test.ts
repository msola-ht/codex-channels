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
  isMetricsProviderId,
  validateMetricsCommandArgs,
} from "../scripts/metrics-command-options.mjs";
import { primaryProviderBackupPath } from "../runtime/model-provider-runtime.mjs";
import { securePrivateDirectorySync, securePrivateFileSync } from "../runtime/private-file.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("metrics command options", () => {
  it("accepts shared scope filters for Threads, Turns, reports and exports", () => {
    const filters = ["--from", "2026-01-01", "--to", "2026-01-02", "--model", "model-1", "--status", "failed", "--operation", "compact"];
    expect(parseMetricsThreadsArgs(filters)).toMatchObject({ from: "2026-01-01", to: "2026-01-02", model: "model-1" });
    expect(parseMetricsTurnsArgs(["thread-1", ...filters, "--turn", "turn-1"])).toMatchObject({ threadId: "thread-1", turn: "turn-1" });
    expect(() => validateMetricsCommandArgs("export", [...filters, "--thread", "thread-1", "--turn", "turn-1"])).not.toThrow();
    expect(() => validateMetricsCommandArgs("report", filters)).not.toThrow();
    expect(() => validateMetricsCommandArgs("export", ["--turn", "turn-1"])).toThrow("必须同时指定 Thread");
    expect(() => parseMetricsThreadsArgs(["--status", "invalid"])).toThrow("status");
    expect(() => parseMetricsTurnsArgs(["thread-1", "--range", "7d", "--from", "2026-01-01", "--to", "2026-01-02"])).toThrow("不能与 --range");
  });

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
    expect(() => metricsRangeOptions({ from: "1969-01-01", to: "2026-08-12" }, nowMs))
      .toThrow("自定义日期范围无效");
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

  it("accepts only the documented metrics status JSON flag", () => {
    expect(() => validateMetricsCommandArgs("status", [])).not.toThrow();
    expect(() => validateMetricsCommandArgs("status", ["--json"])).not.toThrow();
    expect(() => validateMetricsCommandArgs("status", ["--json", "unexpected"]))
      .toThrow("codexc metrics status [--json]");
  });

  it("accepts canonical quota ranges and formats", () => {
    expect(() => validateMetricsCommandArgs("quota", ["--range", "90d", "--format", "json"]))
      .not.toThrow();
    expect(() => validateMetricsCommandArgs("quota", ["--range", "365d"]))
      .toThrow("--range 只支持 24h、7d、30d、90d 或 all");
    expect(() => validateMetricsCommandArgs("quota", ["--format", "yaml"]))
      .toThrow("--format 只支持 markdown、json、csv");
  });

  it("allows legacy Provider IDs for prune but rejects unsafe names", () => {
    expect(() => validateMetricsCommandArgs("prune", ["OpenAI"])).not.toThrow();
    expect(() => validateMetricsCommandArgs("prune", ["opencode-go-main"])).not.toThrow();
    expect(() => validateMetricsCommandArgs("prune", ["provider with spaces"]))
      .toThrow("codexc metrics prune <provider>");
    expect(() => validateMetricsCommandArgs("prune", ["OpenAI/legacy"]))
      .toThrow("codexc metrics prune <provider>");
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
    const environment = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
    };

    expect(isMetricsProviderId("OpenAI", environment)).toBe(true);
  });

  it("accepts a backed-up custom primary Provider for prune", () => {
    const connectHome = mkdtempSync(join(tmpdir(), "codexc-metrics-prune-backup-"));
    temporaryDirectories.push(connectHome);
    const backupPath = primaryProviderBackupPath({ CODEX_CONNECT_HOME: connectHome });
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    if (process.platform === "win32") securePrivateDirectorySync(dirname(backupPath));
    writeFileSync(backupPath, JSON.stringify({
      OpenAI: {
        base_url: "https://zzone.example.test/v1",
        wire_api: "responses",
      },
    }), { mode: 0o600 });
    if (process.platform === "win32") securePrivateFileSync(backupPath);
    const environment = { ...process.env, CODEX_CONNECT_HOME: connectHome };

    expect(isMetricsProviderId("OpenAI", environment)).toBe(true);
  });

  it("accepts historical names outside the canonical OpenCode Go namespace", () => {
    expect(() => validateMetricsCommandArgs("prune", ["opencode-go-deepseek"]))
      .not.toThrow();
    expect(() => validateMetricsCommandArgs("prune", ["opencode-go-opencode-go"]))
      .not.toThrow();
  });
});
