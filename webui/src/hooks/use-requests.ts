import { useApi } from "@/hooks/use-api"
import { fetchRequestDetail, fetchRequests } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useRequests(query: MetricsQuery) {
  const queryKey = JSON.stringify(query)
  const state = useApi(async (signal) => ({ queryKey, data: await fetchRequests(query, signal) }), [queryKey])
  return { data: state.data?.data ?? null, error: state.error, errorCode: state.errorCode, refetch: state.refetch,
    loading: state.loading || (state.error === null && state.data?.queryKey !== queryKey) }
}

export function useRequestDetail(id: string) {
  const state = useApi(async (signal) => ({ id, data: await fetchRequestDetail(id, signal) }), [id])
  // Never show the previous record while a different URL is loading.
  const current = state.data?.id === id
  return { data: current ? state.data!.data : null, error: state.error, errorCode: state.errorCode,
    refetch: state.refetch, loading: state.loading || (state.error === null && !current) }
}
