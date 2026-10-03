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
      records: [{ recordedAtMs: 0, weeklyQuota: null, firstTokenMs: 12.5, totalDurationMs: 1234.5, upstreamTtftMs: 672,
        responseUsageAmount: "0.12345678901234567890", upstreamProvider: "deepseek", finishReason: "stop", errorStage: "stream", upstreamErrorCode: "rate_limit", upstreamErrorType: "rate_limit_error",
        requestModel: "requested", responseModel: "echoed", operation: "response",
        requestServiceTier: "priority", serviceTier: "default",
        traffic: { label: "openai", session: "session-2", interaction: 23 } }],
    };
    const render = (format: string) => execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { printMetricsExport } from './scripts/metrics-output-renderer.mjs';
       printMetricsExport(${JSON.stringify(result)}, ${JSON.stringify(format)});`,
    ], { encoding: "utf8" });
    const [headingLine, valueLine] = render("csv").split("\n");
    const headings = headingLine!.split(",");
    const values = valueLine!.split(",");
    for (const [field, value] of Object.entries({ upstreamProvider: "deepseek", finishReason: "stop", errorStage: "stream", upstreamErrorCode: "rate_limit", upstreamErrorType: "rate_limit_error", responseUsageAmount: "0.12345678901234567890", firstTokenMs: "12.5", totalDurationMs: "1234.5", upstreamTtftMs: "672", requestModel: "requested", responseModel: "echoed",
      requestServiceTier: "priority", serviceTier: "default",
      trafficLabel: "openai", trafficSession: "session-2", trafficInteraction: "23" })) {
      expect(values[headings.indexOf(field)]).toBe(value);
    }
    const markdown = render("markdown");
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
