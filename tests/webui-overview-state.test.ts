import { describe, expect, it } from "vitest";

import { resolveDashboardData } from "../webui/src/lib/overview-state.js";
import { formatCalendarDay, formatFailureRate, formatSuccessRate, formatTime, formatTimeZoneLabel, setServerTimeZone } from "../webui/src/lib/format.js";
import { fillDailyRange, fillRecentDays, usageTrendRows } from "../webui/src/lib/trend.js";
import type { OverviewResponse } from "../scripts/webui-api.js";

function responses(name: string, request: object) {
  const range = { name, startAtMs: 1, endAtMs: 2 };
  const overview: OverviewResponse = {
    range, generatedAt: "", global: null, threadCount: 0, turnCount: 0, providers: [],
    weeklyQuota: { limitId: "codex", planType: "plus", usedPercent: 12.5, remainingPercent: 87.5, resetsAt: 1000, observedAtMs: 1, estimate: null },
    errors: { startAtMs: 1, endAtMs: 2, requestCount: 0, unsuccessfulRequestCount: 0, groups: [], totalGroupCount: 0 },
    trend: { range, generatedAt: "", granularity: "day", daily: [] },
    heatmap: { range, generatedAt: "", daily: [] },
  };
  return { request, data: overview };
}

describe("WebUI 控制台范围与数据一致性", () => {
  it.each(["today", "yesterday", "30d", "2026-09-01..2026-09-02"])("rejects previous results when refreshing %s", (name) => {
    const previous = responses(name, {});
    expect(resolveDashboardData({}, previous)).toBeNull();
  });

  it("publishes overview, trend and heatmap from one response", () => {
    const request = {};
    const current = responses("today", request);
    const previous = responses("today", {});
    expect(resolveDashboardData(request, previous)).toBeNull();
    expect(resolveDashboardData(request, current)).toBe(current.data);
  });

  it("does not expose stale charts or quota after a failed refresh", () => {
    const request = {};
    const current = responses("today", request);
    const previous = responses("today", {});
    for (const response of [null, previous]) {
      expect(resolveDashboardData(request, response)).toBeNull();
    }
    expect(resolveDashboardData(request, current)?.weeklyQuota?.usedPercent).toBe(12.5);
  });

  it("rejects stale results when returning to a range and across midnight", () => {
    const request = {};
    const previous = responses("today", {});
    const current = responses("today", request);
    current.data.range = { name: "today", startAtMs: 10, endAtMs: 20 };
    expect(resolveDashboardData(request, current)?.range).toEqual(current.data.range);
    expect(resolveDashboardData(request, previous)).toBeNull();
  });
});

describe("服务端时区展示与日期标签", () => {
  it("preserves server hourly buckets without turning them into daily rows", () => {
    setServerTimeZone("America/New_York");
    const hourly = [
      { hour: "2026-09-18 00:00", requestCount: 1, inputTokens: 10, cachedInputTokens: null, outputTokens: 2 },
      { hour: "2026-09-18 01:00", requestCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    ];
    const rows = usageTrendRows({ granularity: "hour", hourly, generatedAt: "", range: { name: "today", startAtMs: 0, endAtMs: 1 } });
    expect(rows).toEqual(hourly.map(({ hour, ...usage }) => ({ period: hour, ...usage })));
  });
  it("keeps Shanghai midnight in the same day for the trend and heatmap", () => {
    setServerTimeZone("Asia/Shanghai");
    const startAtMs = Date.parse("2026-09-17T16:00:00Z");
    const endAtMs = Date.parse("2026-09-18T03:00:00Z");
    expect(formatTime(startAtMs)).toBe("2026-09-18 00:00");
    expect(formatCalendarDay(startAtMs)).toBe("2026-09-18");
    expect(formatTimeZoneLabel(startAtMs)).toBe("Asia/Shanghai（UTC+08:00）");
    expect(fillDailyRange([], { name: "today", startAtMs, endAtMs }).map((row) => row.day)).toEqual(["2026-09-18"]);
    const heatmap = fillRecentDays([], endAtMs, 90);
    expect(heatmap).toHaveLength(90);
    expect(heatmap.at(-1)?.day).toBe("2026-09-18");
    const midnightHeatmap = fillRecentDays([], startAtMs, 90);
    expect(midnightHeatmap).toHaveLength(90);
    expect(midnightHeatmap.at(-1)?.day).toBe("2026-09-18");
    expect(formatTime(null)).toBe("—");
    expect(() => setServerTimeZone("")).toThrow("服务端未提供时区");
    expect(() => setServerTimeZone("not/a-zone")).toThrow();
  });

  it.each([
    ["2026-03-07T05:00:00Z", "2026-03-10T04:00:00Z", ["2026-03-07", "2026-03-08", "2026-03-09"]],
    ["2026-10-31T04:00:00Z", "2026-11-03T05:00:00Z", ["2026-10-31", "2026-11-01", "2026-11-02"]],
  ])("fills local calendar dates across DST: %s", (start, end, days) => {
    setServerTimeZone("America/New_York");
    expect(formatTime(Date.parse("2026-09-17T16:00:00Z"))).toBe("2026-09-17 12:00");
    expect(fillDailyRange([], { name: "custom", startAtMs: Date.parse(start), endAtMs: Date.parse(end) })
      .map((row) => row.day)).toEqual(days);
    expect(fillRecentDays([], Date.parse(end) - 1, 3).map((row) => row.day)).toEqual(days);
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
