import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  csvCell,
  formatElapsedDuration as formatCliDuration,
  formatLocalTime,
  isRecord,
} from "../scripts/metrics-export-format.mjs";
import { formatElapsedDuration } from "../src/surfaces/elapsed-duration.js";
import { formatElapsedDuration as formatWebuiDuration } from "../webui/src/lib/format.js";

describe("metrics export display helpers", () => {
  it("separates interrupted requests across CLI summaries and retains raw error status in CSV", () => {
    const rendered = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { printMetricsRun, printMetricsReport, printMetricsTurns, printMetricsThreads, printMetricsExport } from './scripts/metrics-output-renderer.mjs';
      const requestOutcomes = { completed: 40, interrupted: 60, failed: 2, incomplete: 1 };
      const interruptionSummary = { followedByCompletion: 58, noObservedCompletion: 2, usageUnobserved: 60 };
      const compact = { model: 'model', hasMixedModels: false, requestCount: 1, unsuccessfulRequestCount: 1,
        requestOutcomes: { completed: 0, interrupted: 1, failed: 0, incomplete: 0 }, inputTokens: 0, outputTokens: 0 };
      const summary = { requestOutcomes, interruptionSummary, compact, requestCount: 103, unsuccessfulRequestCount: 63,
        turnId: 'turn', threadId: 'thread', recordedAtMs: 1, lastRecordedAtMs: 1, turnCount: 1, agentPath: null,
        inputTokens: 100, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 0 };
      const base = { generatedAt: '2026-10-04T00:00:00Z', range: { name: 'all', startAtMs: 0, endAtMs: 2 }, weeklyQuota: null };
      const error = { provider: 'openai', model: 'model', status: 'failed', errorType: 'client_disconnected', httpStatus: null, requestCount: 60 };
      const cases = {
        run: [printMetricsRun, { ...base, threadId: 'thread', latestTurn: summary, threadAggregate: summary }],
        turns: [printMetricsTurns, { ...base, threadId: 'thread', turns: [summary] }],
        threads: [printMetricsThreads, { ...base, threads: [summary] }],
        report: [printMetricsReport, { ...base, report: { aggregate: summary, groups: [{ provider: 'openai', model: 'model', aggregate: summary }], totalGroupCount: 1 },
          errors: { requestCount: 103, unsuccessfulRequestCount: 63, requestOutcomes, groups: [error] } }],
        export: [printMetricsExport, { ...base, records: [{ ...error, recordedAtMs: 1, weeklyQuota: null }] }],
      };
      const result = {};
      const log = console.log;
      for (const [name, [render, value]] of Object.entries(cases)) {
        result[name] = {};
        for (const format of ['markdown', 'csv', 'json']) {
          const lines = [];
          console.log = (...args) => lines.push(args.join(' '));
          try { render(value, format); } finally { console.log = log; }
          result[name][format] = lines.join('\\n');
        }
      }
      console.log(JSON.stringify(result));
    `], { encoding: "utf8" })) as Record<string, Record<"markdown" | "csv" | "json", string>>;
    for (const name of ["run", "turns", "threads", "report"]) {
      expect(rendered[name]!.markdown).toContain("完成：40 · 客户端中断：60 · 其他失败：2 · 未完整观测：1");
      expect(rendered[name]!.markdown).not.toContain("异常 63");
      expect(rendered[name]!.csv).toContain("requestOutcomes.interrupted");
      expect(rendered[name]!.csv).toContain("compactRequestOutcomes.interrupted");
    }
    for (const name of ["run", "turns"]) {
      expect(rendered[name]!.markdown).toContain("同一 Turn 后续有完成 58 次");
      expect(rendered[name]!.markdown).toContain("未观测到后续完成 2 次");
      expect(rendered[name]!.markdown).toContain("中断用量未完整观测 60 次");
      expect(rendered[name]!.markdown).toContain("不代表重试或恢复因果");
      expect(rendered[name]!.csv).toContain("interruptionSummary.followedByCompletion");
    }
    expect(rendered.report!.markdown).toContain("客户端中断 | client_disconnected");
    const reportLines = rendered.report!.csv.split("\n").map((line) => line.split(","));
    const headers = reportLines[0]!;
    const errorRow = reportLines.find((row) => row[0] === "error")!;
    expect(errorRow[headers.indexOf("status")]).toBe("failed");
    expect(errorRow[headers.indexOf("errorType")]).toBe("client_disconnected");
    const aggregateRow = reportLines.find((row) => row[0] === "aggregate")!;
    expect(aggregateRow[headers.indexOf("requestOutcomes.interrupted")]).toBe("60");
    expect(aggregateRow[headers.indexOf("unsuccessfulRequestCount")]).toBe("63");
    expect(JSON.parse(rendered.run!.json).latestTurn.interruptionSummary).toEqual({
      followedByCompletion: 58, noObservedCompletion: 2, usageUnobserved: 60,
    });
    expect(rendered.export!.markdown).toContain("客户端中断");
    expect(rendered.export!.markdown).toContain("客户端中断 | 未观测 | 未观测 | 未观测");
    expect(rendered.export!.csv).toContain("client_disconnected");
  });
  it("keeps report timezone labels independent of DST while formatting each record in local time", () => {
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { formatLocalTime, formatLocalTimeZone } from './scripts/metrics-export-format.mjs';
      const winter = Date.parse('2026-01-15T12:00:00Z');
      const summer = Date.parse('2026-07-15T12:00:00Z');
      Date.now = () => winter;
      const winterLabel = formatLocalTimeZone();
      Date.now = () => summer;
      console.log(JSON.stringify({ winterLabel, summerLabel: formatLocalTimeZone(),
        winterTime: formatLocalTime(winter), summerTime: formatLocalTime(summer) }));
    `], { encoding: "utf8", env: { ...process.env, TZ: "America/Los_Angeles" } }));
    expect(result).toEqual({
      winterLabel: "America/Los_Angeles", summerLabel: "America/Los_Angeles",
      winterTime: "2026-01-15 04:00:00", summerTime: "2026-07-15 05:00:00",
    });
  });
  it.each([
    [0, "0 ms"], [0.125, "0.13 ms"], [672, "672 ms"], [999.994, "999.99 ms"],
    [999.999, "1 s"], [1000, "1 s"], [1250, "1.25 s"], [59994, "59.99 s"],
    [59995, "1 min"], [60000, "1 min"], [65000, "1 min 5 s"],
    [3599500, "1 h"], [3661000, "1 h 1 min 1 s"],
  ])("formats %s ms consistently across surfaces, CLI and WebUI", (value, expected) => {
    expect(formatElapsedDuration(Number(value))).toBe(expected);
    expect(formatCliDuration(Number(value))).toBe(expected);
    expect(formatWebuiDuration(Number(value))).toBe(expected);
  });
  it("exports request latency and echoed model independently of turn timing", () => {
    const result = {
      generatedAt: "2026-09-19T00:00:00Z", range: { name: "all" }, weeklyQuota: null,
      records: [{ recordedAtMs: 100, quotaObservedAtMs: 0,
        weeklyQuota: { limitId: "codex", usedPercentMillionths: 1_000_000, resetsAt: 2_000_000_000, planType: "plus" },
        firstTokenMs: 12.5, totalDurationMs: 1234.5, upstreamTtftMs: 672,
        responseUsageAmount: "0.12345678901234567890", upstreamProvider: "deepseek", finishReason: "stop", errorStage: "stream", upstreamErrorCode: "rate_limit", upstreamErrorType: "rate_limit_error",
        requestModel: "requested", responseModel: "echoed", operation: "response",
        requestServiceTier: "priority", serviceTier: "default",
        traffic: { label: "openai", session: "session-2", interaction: 23 } }],
    };
    const rendered = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { printMetricsExport } from './scripts/metrics-output-renderer.mjs';
       import { format } from 'node:util';
       const result = ${JSON.stringify(result)};
       const render = (kind) => {
         const lines = [];
         const originalLog = console.log;
         try {
           console.log = (...args) => lines.push(format(...args));
           printMetricsExport(result, kind);
           return lines.join('\\n') + '\\n';
         } finally { console.log = originalLog; }
       };
       console.log(JSON.stringify({ csv: render('csv'), markdown: render('markdown') }));`,
    ], { encoding: "utf8" })) as { csv: string; markdown: string };
    const [headingLine, valueLine] = rendered.csv.split("\n");
    const headings = headingLine!.split(",");
    const values = valueLine!.split(",");
    for (const [field, value] of Object.entries({ quotaObservedAtMs: "0", weeklyQuotaObservedAtMs: "0", upstreamProvider: "deepseek", finishReason: "stop", errorStage: "stream", upstreamErrorCode: "rate_limit", upstreamErrorType: "rate_limit_error", responseUsageAmount: "0.12345678901234567890", firstTokenMs: "12.5", totalDurationMs: "1234.5", upstreamTtftMs: "672", requestModel: "requested", responseModel: "echoed",
      requestServiceTier: "priority", serviceTier: "default",
      trafficLabel: "openai", trafficSession: "session-2", trafficInteraction: "23" })) {
      expect(values[headings.indexOf(field)]).toBe(value);
    }
    const markdown = rendered.markdown;
    const markdownLines = markdown.split("\n");
    expect(markdownLines).toContain(`- 时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    const headerIndex = markdownLines.findIndex((line) => line.startsWith("| 时间 |"));
    expect(headerIndex).toBeGreaterThanOrEqual(0);
    const cells = (line: string) => line.slice(1, -1).split("|").map((cell) => cell.trim());
    const headerCells = cells(markdownLines[headerIndex]!);
    expect(headerCells).not.toContain("生成 Token/s");
    expect(headerCells).not.toContain("端到端 Token/s");
    expect(cells(markdownLines[headerIndex + 1]!)).toHaveLength(headerCells.length);
    expect(cells(markdownLines[headerIndex + 2]!)).toHaveLength(headerCells.length);
    expect(markdown).toContain("首 Token");
    expect(markdown).toContain("12.5 ms | 1.23 s | requested | echoed");
    expect(markdown).toContain("openai / session-2 / #23");
  });
  it("keeps local time output stable", () => {
    const local = formatLocalTime(1_785_900_000_000);
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u);
  });

  it("identifies plain records", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it("exports formula-like text as literal CSV cells without changing numbers", () => {
    expect([
      csvCell("=HYPERLINK(\"https://example.com\")"),
      csvCell("+SUM(1,2)"),
      csvCell("-2+3"),
      csvCell("@SUM(1,2)"),
      csvCell("\t=1+1"),
      csvCell("\r=1+1"),
      csvCell("\n=1+1"),
    ]).toEqual([
      "\"'=HYPERLINK(\"\"https://example.com\"\")\"",
      "\"'+SUM(1,2)\"",
      "'-2+3",
      "\"'@SUM(1,2)\"",
      "'\t=1+1",
      "\"'\r=1+1\"",
      "\"'\n=1+1\"",
    ]);
    expect(csvCell(-2)).toBe("-2");
  });
});
