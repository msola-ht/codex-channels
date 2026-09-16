import { describe, expect, it } from "vitest";

import { resolveDashboardData } from "../webui/src/lib/overview-state.js";
import type { DailyUsageResponse, OverviewResponse } from "../scripts/webui-api.js";

function responses(name: string) {
  const range = { name, startAtMs: 1, endAtMs: 2 };
  const overview: OverviewResponse = {
    range, generatedAt: "", global: null, threadCount: 0, turnCount: 0, providers: [], weeklyQuota: null,
    errors: { startAtMs: 1, endAtMs: 2, requestCount: 0, unsuccessfulRequestCount: 0, groups: [], totalGroupCount: 0 },
  };
  const trend: DailyUsageResponse = { range, generatedAt: "", daily: [] };
  return { overview, trend };
}

describe("WebUI 控制台范围与数据一致性", () => {
  it("does not show the previous range when the selection changes", () => {
    const previous = responses("yesterday");
    expect(resolveDashboardData({ range: "30d" }, previous.overview, previous.trend)).toBeNull();
  });

  it("waits for both responses to match the selected range", () => {
    const current = responses("today");
    const previous = responses("30d");
    expect(resolveDashboardData({ range: "today" }, current.overview, previous.trend)).toBeNull();
    expect(resolveDashboardData({ range: "today" }, previous.overview, current.trend)).toBeNull();
    expect(resolveDashboardData({ range: "today" }, current.overview, null)).toBeNull();
    expect(resolveDashboardData({ range: "today" }, null, current.trend)).toBeNull();
    expect(resolveDashboardData({ range: "today" }, current.overview, current.trend)).toEqual(current);
  });

  it("reloads the retained custom range without presenting stale data", () => {
    const query = { from: "2026-09-01", to: "2026-09-02" };
    const current = responses("2026-09-01..2026-09-02");
    const previous = responses("2026-09-01..2026-09-03");
    expect(resolveDashboardData(query, null, null)).toBeNull();
    expect(resolveDashboardData(query, previous.overview, previous.trend)).toBeNull();
    expect(resolveDashboardData(query, current.overview, current.trend)).toEqual(current);
  });
});
