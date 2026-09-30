import { useCallback, useRef, useState } from "react"
import { useApi } from "@/hooks/use-api"
import { useQueueEvents, type QueueSnapshotRead } from "@/hooks/use-queue-events"
import { ApiClientError, fetchRelayQueue, watchRelayQueue } from "@/lib/api"

/** Mounted only while the queue sheet is open; snapshots follow change notifications. */
export function useRelayQueue() {
  const latest = useRef(0)
  const [read, setRead] = useState<QueueSnapshotRead | null>(null)
  const load = useCallback(async (signal?: AbortSignal) => {
    const revision = latest.current
    try {
      const snapshot = await fetchRelayQueue(signal)
      if (snapshot.state === "unknown") throw new ApiClientError("Relay queue snapshot unconfirmed", 503, "relay_queue_unconfirmed")
      if (!signal?.aborted) setRead({ confirmed: revision, completedAt: Date.now(), failed: false, failures: 0, retryable: false, retryAt: 0 })
      return snapshot
    } catch (error) {
      if (!signal?.aborted) {
        const limited = error instanceof ApiClientError && error.status === 429
        const retryable = error instanceof ApiClientError ? limited || error.status >= 500
          : error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError")
        setRead(previous => {
          const failures = (previous?.failures ?? 0) + 1
          const completedAt = Date.now()
          return { confirmed: previous?.confirmed ?? 0, completedAt, failed: true, failures, retryable,
            retryAt: completedAt + (limited ? 60_000 : Math.min(8_000, 2_000 * 2 ** Math.min(failures - 1, 2))) }
        })
      }
      throw error
    }
  }, [])
  const state = useApi(load, [], { retainDataOnError: false })
  const notificationStatus = useQueueEvents(state.refetch, state.loading, true, latest, read, watchRelayQueue)
  return { ...state, notificationStatus }
}
