import { useCallback } from "react"
import { useMetricsSnapshot } from "@/hooks/use-metrics-snapshot"
import { fetchRequests } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useRequests(query: MetricsQuery) {
  const queryKey = JSON.stringify(query)
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => ({ queryKey, data: await fetchRequests(query, signal) }), [query, queryKey])
  return useMetricsSnapshot(query, queryKey, fetchSnapshot)
}
