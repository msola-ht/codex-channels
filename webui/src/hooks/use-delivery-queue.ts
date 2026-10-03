import { watchDeliveryQueue } from "@/lib/api"
import { useCallback, useRef, useState } from "react"
import { useApi, useApiPolling } from "@/hooks/use-api"
import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { ApiClientError, fetchDeliveryContents, fetchDeliveryQueue, previewDeliveryBatch, applyDeliveryBatch } from "@/lib/api"
import type { DeliveryBatchInput, DeliveryBatchResult, DeliveryContent, DeliveryQueueEntry } from "@/lib/types"

async function applyRetry(input: DeliveryBatchInput, token: string, signal?: AbortSignal) {
  try { return await applyDeliveryBatch(input, token, signal) }
  catch (error) {
    // Losing the HTTP response does not prove that the requeue transaction failed.
    if (error instanceof ApiClientError && (error.status < 500 || error.code === "management_audit_unavailable")) throw error
    throw new ApiClientError("Delivery retry result unconfirmed", 503, "delivery_unconfirmed")
  }
}

/** The list is remounted when its cursor or filter changes. */
export function useDeliveryQueue(before: number, filter: string) {
  const fetchSnapshot = useCallback((signal?: AbortSignal) => fetchDeliveryQueue(before, filter, signal), [before, filter])
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const state = useManagementConfirmedMutation({ load, preview: previewDeliveryBatch, apply: applyRetry, retainDataOnError: false })
  const [result, setResult] = useState<DeliveryBatchResult | null>(null)
  const notificationStatus = useQueueEvents(state.refetch, state.loading, !state.busy && state.pendingPreview === null, latest, read, watchDeliveryQueue)
  const confirm = async () => {
    setResult(null)
    setResult(await state.confirm())
  }
  const mutate = async (input: DeliveryBatchInput) => {
    setResult(null)
    return state.mutate(input)
  }
  return { ...state, mutate, confirm, result, notificationStatus }
}

type ContentResult = { content: DeliveryContent | null; error: boolean; attempts: number; retryable: boolean; retryAt: number }

/** One bounded request for new revisions; transient errors get at most two delayed retries. */
export function useDeliveryContents(records: DeliveryQueueEntry[]) {
  const cache = useRef(new Map<string, ContentResult>())
  const key = JSON.stringify(records.map(({ id, revision }) => [id, revision]))
  const state = useApi(async signal => {
    signal.throwIfAborted()
    const entries = JSON.parse(key) as Array<[string, string]>
    const active = new Set(entries.map(entry => JSON.stringify(entry)))
    for (const stored of cache.current.keys()) if (!active.has(stored)) cache.current.delete(stored)
    const missing = entries.filter(entry => {
      const result = cache.current.get(JSON.stringify(entry))
      return !result || (result.error && result.retryable && result.attempts < 3 && Date.now() >= result.retryAt)
    })
    if (missing.length) {
      try {
        const response = await fetchDeliveryContents(missing.map(([id, revision]) => ({ id, revision })), signal)
        signal.throwIfAborted()
        for (const { id, revision, content } of response.records) {
          const entryKey = JSON.stringify([id, revision])
          cache.current.set(entryKey, { content, error: content === null, attempts: 1, retryable: false, retryAt: 0 })
        }
      } catch (error) {
        signal.throwIfAborted()
        const retryable = !(error instanceof ApiClientError) || error.status === 429 || error.status >= 500
        for (const entry of missing) {
          const entryKey = JSON.stringify(entry)
          cache.current.set(entryKey, { content: null, error: true, retryable, retryAt: Date.now() + 60_000, attempts: (cache.current.get(entryKey)?.attempts ?? 0) + 1 })
        }
      }
    }
    return new Map(cache.current)
  }, [key], { retainDataOnError: false })
  const retryable = [...(state.data?.values() ?? [])].some(result => result.error && result.retryable && result.attempts < 3)
  useApiPolling(state.refetch, state.loading, retryable, 60_000)
  return { ...state, refetch: () => {
    for (const [entryKey, result] of cache.current) if (result.error) cache.current.delete(entryKey)
    state.refetch()
  } }
}
