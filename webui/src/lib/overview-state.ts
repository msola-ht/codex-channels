import type { DailyUsageResponse, OverviewResponse } from "./types"

export interface DashboardResponse<T> {
  request: object
  data: T
}

export function resolveDashboardData(
  request: object,
  overview: DashboardResponse<OverviewResponse> | null,
  trend: DashboardResponse<DailyUsageResponse> | null,
) {
  return {
    overview: overview?.request === request ? overview.data : null,
    trend: trend?.request === request ? trend.data : null,
  }
}
