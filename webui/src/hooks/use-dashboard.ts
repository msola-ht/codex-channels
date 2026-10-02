import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { scheduleVisibleSettingsRefresh } from "@/lib/api-polling"
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
  const visibilityRefresh = useRef({ pending: false, lastRefresh: Date.now() })
  const refetch = useCallback(() => {
    visibilityRefresh.current.pending = false
    visibilityRefresh.current.lastRefresh = Date.now()
    setRevision(value => value + 1)
  }, [])
  useEffect(() => scheduleVisibleSettingsRefresh(refetch, overview.loading, document, visibilityRefresh.current), [refetch, overview.loading])
  return {
    data: current, loading: overview.loading, error: overview.error, errorCode: overview.errorCode,
    refetch,
  }
}
