import { describe, expect, it } from "vitest";

import {
  positionTrendTooltip,
  toStackedUsageTrend,
} from "../webui/src/lib/trend.js";

describe("WebUI 用量趋势", () => {
  it("将包含关系的原始 Token 拆成互斥堆叠项", () => {
    const row = toStackedUsageTrend([{
      day: "2026-08-23",
      inputTokens: 495_000_000,
      cachedInputTokens: 487_000_000,
      outputTokens: 1_285_000,
      reasoningOutputTokens: 578_000,
    }])[0]!;

    expect(row).toEqual({
      day: "08-23",
      uncachedInputTokens: 8_000_000,
      cachedInputTokens: 487_000_000,
      nonReasoningOutputTokens: 707_000,
      reasoningOutputTokens: 578_000,
    });
    expect(
      row.uncachedInputTokens
      + row.cachedInputTokens
      + row.nonReasoningOutputTokens
      + row.reasoningOutputTokens,
    ).toBe(496_285_000);
  });

  it("让提示框紧邻鼠标，并在右边缘翻到左侧", () => {
    expect(positionTrendTooltip([300, 100], [220, 90], [800, 230])).toEqual([312, 112]);
    expect(positionTrendTooltip([700, 180], [220, 90], [800, 230])).toEqual([468, 140]);
  });
});
