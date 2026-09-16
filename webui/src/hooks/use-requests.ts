import { useApi } from "@/hooks/use-api"
import { fetchRequests } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useRequests(query: MetricsQuery) {
  return useApi(
    (signal) => fetchRequests(
      query,
      signal,
    ),
    [JSON.stringify(query)],
  )
}
