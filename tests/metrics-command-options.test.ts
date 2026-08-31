import { describe, expect, it } from "vitest";

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

  it("accepts only the documented metrics status JSON flag", () => {
    expect(() => validateMetricsCommandArgs("status", [])).not.toThrow();
    expect(() => validateMetricsCommandArgs("status", ["--json"])).not.toThrow();
    expect(() => validateMetricsCommandArgs("status", ["--json", "unexpected"]))
      .toThrow("codexc metrics status [--json]");
  });

  it("accepts historical quota ranges and formats", () => {
    expect(() => validateMetricsCommandArgs("quota", ["--range", "365d", "--format", "json"]))
      .not.toThrow();
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
});
