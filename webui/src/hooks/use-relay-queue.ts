import { useApi, useApiPolling } from "@/hooks/use-api"
import { fetchRelayQueue } from "@/lib/api"

/** Mounted only while the queue sheet is open. */
export function useRelayQueue() {
  const state = useApi(fetchRelayQueue, [], { retainDataOnError: false })
  useApiPolling(state.refetch, state.loading, true)
  return state
}
