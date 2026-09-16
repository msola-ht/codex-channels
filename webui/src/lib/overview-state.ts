import type { DailyUsageResponse, MetricsRangeQuery, OverviewResponse } from "./types"

export function resolveDashboardData(
  query: MetricsRangeQuery,
  overview: OverviewResponse | null,
  trend: DailyUsageResponse | null,
) {
  const name = query.range ?? `${query.from}..${query.to}`
  if (overview?.range.name !== name || trend?.range.name !== name) return null
  return { overview, trend }
}
