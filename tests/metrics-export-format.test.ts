import { describe, expect, it } from "vitest";

import {
  csvCell,
  formatDuration,
  formatLocalTime,
  isRecord,
} from "../scripts/metrics-export-format.mjs";

describe("metrics export display helpers", () => {
  it("keeps duration and local time output stable", () => {
    expect(formatDuration(null)).toBe("未知");
    expect(formatDuration(7_418)).toBe("7418ms");
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
