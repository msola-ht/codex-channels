import { describe, expect, it } from "vitest";

import {
  convertCostToCny,
  csvCell,
  enrichCosts,
  formatCost,
  formatCurrencyNanos,
  formatDuration,
  formatLocalTime,
  isRecord,
  type MetricsDisplayContext,
} from "../scripts/metrics-export-format.mjs";

const displayContext: MetricsDisplayContext = {
  priceCurrency: "auto",
  priceCurrencyByProvider: {},
  exchangeRate: {
    usdToCny: 6.7629,
    effectiveAtMs: 1_785_900_000_000,
    source: "open-er-api",
  },
};

describe("metrics export display helpers", () => {
  it("converts USD cost to CNY only for CNY-displayed providers with a rate", () => {
    expect(convertCostToCny(1_000_000_000, "USD", "deepseek", displayContext))
      .toBe(6_762_900_000);
    expect(convertCostToCny(1_000_000_000, "USD", "openai", displayContext))
      .toBe(null);
    expect(convertCostToCny(1_000_000_000, "USD", "deepseek", {
      ...displayContext,
      exchangeRate: null,
    })).toBe(null);
    expect(convertCostToCny(1_000_000_000, "CNY", "deepseek", displayContext))
      .toBe(null);
    expect(convertCostToCny(null, "USD", "deepseek", displayContext)).toBe(null);
  });

  it("appends CNY cost columns while preserving original values", () => {
    const turn = {
      provider: "deepseek",
      pricingCurrency: "USD",
      totalCostNanos: 33_750_695,
      inputCostNanos: 2_935_240,
      cachedInputCostNanos: 25_711_615,
      outputCostNanos: 5_103_840,
    };
    expect(enrichCosts(turn, displayContext)).toEqual({
      ...turn,
      totalCostCnyNanos: 228_252_575,
      inputCostCnyNanos: 19_850_735,
      cachedInputCostCnyNanos: 173_885_081,
      outputCostCnyNanos: 34_516_760,
    });
    expect(enrichCosts(turn, null)).toEqual({
      ...turn,
      totalCostCnyNanos: null,
      inputCostCnyNanos: null,
      cachedInputCostCnyNanos: null,
      outputCostCnyNanos: null,
    });
  });

  it("reads the currency from nested pricing snapshots", () => {
    const record = {
      provider: "deepseek",
      pricing: { currency: "USD" },
      totalCostNanos: 1_000_000_000,
    };
    expect(enrichCosts(record, displayContext)!.totalCostCnyNanos)
      .toBe(6_762_900_000);
  });

  it("formats costs with the configured display currency and trimmed precision", () => {
    expect(formatCost({
      provider: "deepseek",
      pricingCurrency: "USD",
      totalCostNanos: 1_478_557,
    }, displayContext)).toBe("¥0.009999");
    expect(formatCost({
      provider: "openai",
      pricingCurrency: "USD",
      totalCostNanos: 1_478_557,
    }, displayContext)).toBe("$0.001479");
    expect(formatCost({
      provider: "deepseek",
      pricingCurrency: null,
      totalCostNanos: null,
    }, displayContext)).toBe("未知");
  });

  it("formats currency nanos with conversion and trimmed zeros", () => {
    expect(formatCurrencyNanos(
      1_478_557,
      "USD",
      displayContext,
      "deepseek",
    )).toBe("¥0.009999");
    expect(formatCurrencyNanos(1_478_557, "USD", null, "deepseek"))
      .toBe("$0.001479");
  });

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
