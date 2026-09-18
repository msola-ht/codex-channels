import { useCallback, useMemo, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { fetchOverview } from "@/lib/api"
import { resolveDashboardData } from "@/lib/overview-state"
import type { MetricsRangeQuery } from "@/lib/types"

export function useDashboard(query: MetricsRangeQuery) {
  const [revision, setRevision] = useState(0)
  // 切换范围、返回之前的范围和手动刷新均产生独立批次；不把同名范围视为同一轮结果。
  const request = useMemo(() => ({ query, revision }), [query, revision])
  const overview = useApi(async (signal) => ({
    request, data: await fetchOverview(request.query, signal),
  }), [request])
  const current = resolveDashboardData(request, overview.data)
  const refetch = useCallback(() => setRevision((value) => value + 1), [])
  return {
    data: current, loading: overview.loading, error: overview.error,
    refetch,
  }
}
