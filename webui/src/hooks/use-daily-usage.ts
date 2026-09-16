import { useApi } from "@/hooks/use-api"
import { fetchDailyUsage } from "@/lib/api"
import type { MetricsRangeQuery } from "@/lib/types"

export function useDailyUsage(query: MetricsRangeQuery) {
  return useApi(
    (signal) => fetchDailyUsage(query, signal),
    [JSON.stringify(query)],
  )
}
