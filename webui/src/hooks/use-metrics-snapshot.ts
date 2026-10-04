import { useApi } from "@/hooks/use-api"
import { useRangeRefresh } from "@/hooks/use-range-refresh"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { watchRequestMetrics } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

/** List/detail metrics keep their previous layout while a new query loads. */
export function useMetricsSnapshot<T>(
  query: MetricsQuery,
  queryKey: string,
  fetchSnapshot: (signal?: AbortSignal) => Promise<{ queryKey: string; data: T }>,
) {
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const state = useApi(load, [queryKey])
  const historyPage = (query.offset ?? 0) > 0
  const current = state.data?.queryKey === queryKey
  useRangeRefresh(query, state.refetch, state.lastReadStartedAt, historyPage || state.loading || state.error !== null || !current)
  const notificationStatus = useQueueEvents(state.refetch, state.loading, !historyPage, latest, read, watchRequestMetrics)
  return { data: state.data?.data ?? null, error: state.error, errorCode: state.errorCode, refetch: state.refetch,
    lastUpdatedAt: current ? state.lastUpdatedAt : null,
    notificationStatus: historyPage ? "paused" as const : notificationStatus,
    refreshing: state.loading || (state.error === null && !current),
    loading: state.error === null && !current }
}
