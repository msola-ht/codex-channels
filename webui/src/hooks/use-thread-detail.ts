import { useApi } from "@/hooks/use-api"
import { fetchThreadRun, fetchThreadTurns } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useThreadRun(threadId: string) {
  return useApi(
    (signal) => fetchThreadRun(threadId, signal),
    [threadId],
  )
}

export function useThreadTurns(threadId: string, query: MetricsQuery) {
  const queryKey = JSON.stringify([threadId, query])
  const state = useApi(async (signal) => ({ queryKey, data: await fetchThreadTurns(threadId, query, signal) }), [queryKey])
  return { data: state.data?.data ?? null, error: state.error, refetch: state.refetch,
    loading: state.loading || (state.error === null && state.data?.queryKey !== queryKey) }
}
