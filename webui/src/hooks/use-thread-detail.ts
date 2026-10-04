import { useCallback } from "react"
import { useApi } from "@/hooks/use-api"
import { useRangeRefresh } from "@/hooks/use-range-refresh"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { fetchThreadRun, fetchThreadTurns, watchRequestMetrics } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useThreadDetail(threadId: string, query: MetricsQuery) {
  const queryKey = JSON.stringify([threadId, query])
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => {
    const batch = new AbortController()
    const batchSignal = signal === undefined ? batch.signal : AbortSignal.any([signal, batch.signal])
    try {
      const [run, turns] = await Promise.all([fetchThreadRun(threadId, batchSignal), fetchThreadTurns(threadId, query, batchSignal)])
      return { queryKey, data: { run, turns } }
    } catch (error) {
      batch.abort()
      throw error
    }
  }, [threadId, query, queryKey])
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const state = useApi(load, [queryKey])
  const historyPage = (query.offset ?? 0) > 0
  useRangeRefresh(query, state.refetch, state.lastReadStartedAt, historyPage || state.loading || state.error !== null || state.data?.queryKey !== queryKey)
  const notificationStatus = useQueueEvents(state.refetch, state.loading, !historyPage, latest, read, watchRequestMetrics)
  return { data: state.data?.data ?? null, error: state.error, errorCode: state.errorCode, refetch: state.refetch,
    lastUpdatedAt: state.data?.queryKey === queryKey ? state.lastUpdatedAt : null,
    revision: read,
    notificationStatus: historyPage ? "paused" as const : notificationStatus,
    refreshing: state.loading || (state.error === null && state.data?.queryKey !== queryKey),
    loading: state.error === null && state.data?.queryKey !== queryKey }
}
