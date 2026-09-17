import { useApi } from "@/hooks/use-api"
import { fetchTrafficExchange, fetchTrafficExchanges } from "@/lib/api"

export function useTrafficExchanges(
  query: { label?: string; limit?: number; offset?: number; session?: string } | null,
) {
  return useApi(
    (signal) => query === null
      ? Promise.resolve(null)
      : fetchTrafficExchanges(query, signal),
    [JSON.stringify(query)],
  )
}

export function useTrafficExchange(
  query: { id: number; label?: string; session?: string } | null,
) {
  return useApi(
    (signal) => query === null
      ? Promise.resolve(null)
      : fetchTrafficExchange(query, signal),
    [JSON.stringify(query)],
  )
}
