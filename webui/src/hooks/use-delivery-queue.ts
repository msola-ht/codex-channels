import { useCallback, useRef, useState } from "react"
import { useApi, useApiPolling } from "@/hooks/use-api"
import { useManagementConfirmedMutation } from "@/hooks/use-management-confirmed-mutation"
import { ApiClientError, fetchDeliveryContent, fetchDeliveryQueue, previewDeliveryBatch, applyDeliveryBatch } from "@/lib/api"
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
  const load = useCallback((signal?: AbortSignal) => fetchDeliveryQueue(before, filter, signal), [before, filter])
  const state = useManagementConfirmedMutation({ load, preview: previewDeliveryBatch, apply: applyRetry, retainDataOnError: false })
  const [result, setResult] = useState<DeliveryBatchResult | null>(null)
  useApiPolling(state.refetch, state.loading, !state.busy && state.pendingPreview === null, 10_000)
  const confirm = async () => {
    setResult(null)
    setResult(await state.confirm())
  }
  const mutate = async (input: DeliveryBatchInput) => {
    setResult(null)
    return state.mutate(input)
  }
  return { ...state, mutate, confirm, result }
}

type ContentResult = { content: DeliveryContent | null; error: boolean }

/** Load only new revisions, at most three requests at once; discard cache when leaving the page. */
export function useDeliveryContents(records: DeliveryQueueEntry[]) {
  const cache = useRef(new Map<string, ContentResult>())
  const key = JSON.stringify(records.map(({ id, revision }) => [id, revision]))
  const state = useApi(async signal => {
    const entries = JSON.parse(key) as Array<[string, string]>
    const active = new Set(entries.map(([id, revision]) => JSON.stringify([id, revision])))
    for (const stored of cache.current.keys()) if (!active.has(stored)) cache.current.delete(stored)
    let cursor = 0
    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, async () => {
      while (cursor < entries.length) {
        signal.throwIfAborted()
        const [id, revision] = entries[cursor++]!
        const entryKey = JSON.stringify([id, revision])
        if (cache.current.has(entryKey)) continue
        let result: ContentResult
        try {
          const content = await fetchDeliveryContent({ id, revision }, signal)
          result = { content: { ...content, text: content.text?.slice(0, 160) ?? null }, error: false }
        } catch {
          signal.throwIfAborted()
          result = { content: null, error: true }
        }
        signal.throwIfAborted()
        cache.current.set(entryKey, result)
      }
    }))
    return new Map(cache.current)
  }, [key], { retainDataOnError: false })
  return { ...state, refetch: () => {
    for (const [entryKey, result] of cache.current) if (result.error) cache.current.delete(entryKey)
    state.refetch()
  } }
}
