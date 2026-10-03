import { useCallback, useMemo } from "react"

import { useApi } from "@/hooks/use-api"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { fetchOverview, watchRequestMetrics } from "@/lib/api"
import { resolveDashboardData } from "@/lib/overview-state"
import type { MetricsRangeQuery } from "@/lib/types"

export function useDashboard(query: MetricsRangeQuery) {
  // Scope changes replace the display; same-scope reads keep the last complete snapshot.
  // useApi cancels superseded reads so late responses cannot overwrite a newer refresh.
  const request = useMemo(() => ({ query }), [query])
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => ({
    request, data: await fetchOverview(request.query, signal),
  }), [request])
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const overview = useApi(load, [request])
  const current = resolveDashboardData(request, overview.data)
  const refetch = overview.refetch
  const notificationStatus = useQueueEvents(refetch, overview.loading, true, latest, read, watchRequestMetrics)
  return {
    data: current, loading: current === null && overview.error === null,
    refreshing: overview.loading || (overview.error === null && current === null),
    error: overview.error, errorCode: overview.errorCode,
    refetch, notificationStatus,
  }
}
