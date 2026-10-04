import { useCallback } from "react"
import { useMetricsSnapshot } from "@/hooks/use-metrics-snapshot"
import { fetchThreads } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useThreads(query: MetricsQuery) {
  const queryKey = JSON.stringify(query)
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => ({ queryKey, data: await fetchThreads(query, signal) }), [query, queryKey])
  return useMetricsSnapshot(query, queryKey, fetchSnapshot)
}
