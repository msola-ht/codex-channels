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
  return useApi(
    (signal) => fetchThreadTurns(threadId, query, signal),
    [threadId, JSON.stringify(query)],
  )
}
