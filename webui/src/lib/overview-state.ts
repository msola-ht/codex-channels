import type { OverviewResponse } from "./types"

export interface DashboardResponse<T> {
  request: object
  data: T
}

export function resolveDashboardData(
  request: object,
  response: DashboardResponse<OverviewResponse> | null,
) {
  return response?.request === request ? response.data : null
}
