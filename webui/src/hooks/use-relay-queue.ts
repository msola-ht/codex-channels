import { useApi } from "@/hooks/use-api"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { ApiClientError, fetchRelayQueue, watchRelayQueue } from "@/lib/api"

async function fetchConfirmedQueue(signal?: AbortSignal) {
  const snapshot = await fetchRelayQueue(signal)
  if (snapshot.state === "unknown") throw new ApiClientError("Relay queue snapshot unconfirmed", 503, "relay_queue_unconfirmed")
  return snapshot
}

/** Mounted only while the queue page is active; snapshots follow change notifications. */
export function useRelayQueue() {
  const { load, latest, read } = useQueueSnapshot(fetchConfirmedQueue)
  const state = useApi(load, [], { retainDataOnError: false })
  const notificationStatus = useQueueEvents(state.refetch, state.loading, true, latest, read, watchRelayQueue)
  return { ...state, notificationStatus }
}
