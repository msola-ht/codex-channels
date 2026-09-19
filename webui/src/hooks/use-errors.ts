import { useApi } from "@/hooks/use-api"
import { fetchErrors } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useErrors(query: MetricsQuery) {
  const queryKey = JSON.stringify(query)
  const state = useApi(async (signal) => ({ queryKey, data: await fetchErrors(query, signal) }), [queryKey])
  return { data: state.data?.data ?? null, error: state.error, refetch: state.refetch,
    loading: state.loading || (state.error === null && state.data?.queryKey !== queryKey) }
}
