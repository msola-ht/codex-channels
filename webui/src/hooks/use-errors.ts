import { useApi } from "@/hooks/use-api"
import { fetchErrors } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useErrors(query: MetricsQuery) {
  return useApi(
    (signal) => fetchErrors(query, signal),
    [JSON.stringify(query)],
  )
}
