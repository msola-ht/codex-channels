import { useApi } from "@/hooks/use-api"
import { fetchOverview } from "@/lib/api"
import type { MetricsRangeQuery } from "@/lib/types"

export function useOverview(query: MetricsRangeQuery) {
  return useApi(
    (signal) => fetchOverview(query, signal),
    [JSON.stringify(query)],
  )
}
