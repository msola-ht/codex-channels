import { useCallback } from "react"
import { useApi } from "@/hooks/use-api"
import { useRangeRefresh } from "@/hooks/use-range-refresh"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { fetchRequests, watchRequestMetrics } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useRequests(query: MetricsQuery) {
  const queryKey = JSON.stringify(query)
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => ({ queryKey, data: await fetchRequests(query, signal) }), [query, queryKey])
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const state = useApi(load, [queryKey])
  const historyPage = (query.offset ?? 0) > 0
  useRangeRefresh(query, state.refetch, state.lastReadStartedAt, historyPage || state.loading || state.error !== null || state.data?.queryKey !== queryKey)
  const notificationStatus = useQueueEvents(state.refetch, state.loading, !historyPage, latest, read, watchRequestMetrics)
  return { data: state.data?.data ?? null, error: state.error, errorCode: state.errorCode, refetch: state.refetch,
    lastUpdatedAt: state.data?.queryKey === queryKey ? state.lastUpdatedAt : null,
    notificationStatus: historyPage ? "paused" as const : notificationStatus,
    refreshing: state.loading || (state.error === null && state.data?.queryKey !== queryKey),
    loading: state.error === null && state.data?.queryKey !== queryKey }
}
