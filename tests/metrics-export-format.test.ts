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
      records: [{ recordedAtMs: 0, weeklyQuota: null, firstContentMs: 12.5, upstreamTtftMs: 672,
        requestModel: "requested", responseModel: "echoed", operation: "response",
        traffic: { label: "openai", session: "session-2", interaction: 23 } }],
    };
    const render = (format: string) => execFileSync(process.execPath, ["--input-type=module", "-e",
      `import { printMetricsExport } from './scripts/metrics-output-renderer.mjs';
       printMetricsExport(${JSON.stringify(result)}, ${JSON.stringify(format)});`,
    ], { encoding: "utf8" });
    const [headingLine, valueLine] = render("csv").split("\n");
    const headings = headingLine!.split(",");
    const values = valueLine!.split(",");
    for (const [field, value] of Object.entries({ firstContentMs: "12.5", upstreamTtftMs: "672", requestModel: "requested", responseModel: "echoed",
      trafficLabel: "openai", trafficSession: "session-2", trafficInteraction: "23" })) {
      expect(values[headings.indexOf(field)]).toBe(value);
    }
    const markdown = render("markdown");
    expect(markdown).toContain("首字耗时");
    expect(markdown).toContain("12.5 ms | 672 ms | requested | echoed");
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
