import { describe, expect, it } from "vitest";

import { resolveDashboardData } from "../webui/src/lib/overview-state.js";
import { formatFailureRate, formatSuccessRate } from "../webui/src/lib/format.js";
import type { DailyUsageResponse, OverviewResponse } from "../scripts/webui-api.js";

function responses(name: string, request: object) {
  const range = { name, startAtMs: 1, endAtMs: 2 };
  const overview: OverviewResponse = {
    range, generatedAt: "", global: null, threadCount: 0, turnCount: 0, providers: [],
    weeklyQuota: { limitId: "codex", planType: "plus", usedPercent: 12.5, remainingPercent: 87.5, resetsAt: 1000, observedAtMs: 1, estimate: null },
    errors: { startAtMs: 1, endAtMs: 2, requestCount: 0, unsuccessfulRequestCount: 0, groups: [], totalGroupCount: 0 },
  };
  const trend: DailyUsageResponse = { range, generatedAt: "", daily: [] };
  return { overview: { request, data: overview }, trend: { request, data: trend } };
}

describe("WebUI 控制台范围与数据一致性", () => {
  it.each(["today", "yesterday", "30d", "2026-09-01..2026-09-02"])("rejects previous results when refreshing %s", (name) => {
    const previous = responses(name, {});
    expect(resolveDashboardData({}, previous.overview, previous.trend)).toEqual({ overview: null, trend: null });
  });

  it("never combines a new response with the previous batch in either completion order", () => {
    const request = {};
    const current = responses("today", request);
    const previous = responses("today", {});
    expect(resolveDashboardData(request, current.overview, previous.trend)).toEqual({ overview: current.overview.data, trend: null });
    expect(resolveDashboardData(request, previous.overview, current.trend)).toEqual({ overview: null, trend: current.trend.data });
    expect(resolveDashboardData(request, current.overview, current.trend)).toEqual({ overview: current.overview.data, trend: current.trend.data });
  });

  it("keeps the current quota when the trend is missing or a failed refresh retains its old result", () => {
    const request = {};
    const current = responses("today", request);
    const previous = responses("today", {});
    for (const trend of [null, previous.trend]) {
      const result = resolveDashboardData(request, current.overview, trend);
      expect(result.overview?.weeklyQuota?.usedPercent).toBe(12.5);
      expect(result.trend).toBeNull();
    }
    expect(resolveDashboardData(request, null, null)).toEqual({ overview: null, trend: null });
  });

  it("rejects stale results when returning to a range and across midnight", () => {
    const request = {};
    const previous = responses("today", {});
    const current = responses("today", request);
    current.overview.data.range = { name: "today", startAtMs: 10, endAtMs: 20 };
    expect(resolveDashboardData(request, current.overview, previous.trend).trend).toBeNull();
    expect(resolveDashboardData(request, previous.overview, previous.trend).overview).toBeNull();
  });
});

describe("WebUI 成功率与失败率", () => {
  it.each([[100, 1, "1.0%", "99.0%"], [100, 0, "0.0%", "100.0%"], [100, 100, "100.0%", "0.0%"], [0, 0, "—", "—"]] as const)(
    "formats %i requests with %i failures", (requests, failures, failureRate, successRate) => {
      expect(formatFailureRate(requests, failures)).toBe(failureRate);
      expect(formatSuccessRate(requests, failures)).toBe(successRate);
    },
  );
});
