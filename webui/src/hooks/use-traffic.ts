import { useCallback, useRef } from "react"

import { useApi } from "@/hooks/use-api"
import { ApiClientError, fetchTrafficExchange, fetchTrafficExchanges, fetchTrafficTrace, watchTraffic } from "@/lib/api"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { canReuseTrafficSummary, resolveTrafficData, resolveTrafficDetailSnapshot } from "@/lib/traffic-state"
import type { QueueChangeEvent, TrafficDetailResponse } from "@/lib/types"

export function useTrafficExchanges(
  query: { label?: string; limit?: number; offset?: number; session?: string } | null,
) {
  const missingKey = useRef<string | null>(null)
  const key = JSON.stringify(query)
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const current = JSON.parse(key) as typeof query
    try {
      const value = current === null ? null : await fetchTrafficExchanges(current, signal)
      if (!signal?.aborted) missingKey.current = null
      return { key, value }
    } catch (error) {
      if (!signal?.aborted && error instanceof ApiClientError && trafficMissingCodes.includes(error.code)) missingKey.current = key
      throw error
    }
  }, [key])
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const result = useApi(load, [key])
  const scope = JSON.stringify(query === null ? null : { label: query.label, session: query.session })
  const watch = useCallback((signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchTraffic(JSON.parse(scope), signal, receive), [scope])
  const history = (query?.offset ?? 0) > 0
  const status = useQueueEvents(result.refetch, result.loading, query !== null && !history, latest, read, query === null ? null : watch, true)
  const unavailable = missingKey.current === key || result.error !== null && trafficMissingCodes.includes(result.errorCode ?? "")
  const data = unavailable ? null : resolveTrafficData(key, result.data)
  return { ...result, data, notificationStatus: history ? "paused" as const : status,
    loading: query !== null && data === null && result.error === null, refreshing: result.loading }
}

export function useTrafficExchange(
  query: { traceOffset?: number; id: number; label?: string; session?: string } | null,
) {
  const snapshot = useRef<TrafficDetailResponse | null>(null)
  const anchor = useRef<{ key: string; target: { label: string; session: string; id: number } | null; missing: boolean } | null>(null)
  const key = JSON.stringify(query)
  const identity = JSON.stringify(query === null ? null : { label: query.label, session: query.session, id: query.id })
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const requested = JSON.parse(key) as typeof query
    if (requested === null) {
      snapshot.current = null
      anchor.current = null
      return { key, value: null }
    }
    const owner = anchor.current?.key === identity ? anchor.current : { key: identity, target: null, missing: false }
    anchor.current = owner
    const current = { ...requested, ...owner.target }
    const previous = resolveTrafficDetailSnapshot(current, snapshot.current)
    let value: TrafficDetailResponse
    try {
      if (previous !== null && canReuseTrafficSummary(previous.exchange)) {
        const page = await fetchTrafficTrace({
          ...current, label: previous.label, session: previous.session,
        }, signal)
        // A late trace flush can add output/model evidence after the terminal index.
        // Rebuild the summary only when this call's trace changed, not for other calls in the batch.
        value = previous.exchange.tracePage.total === page.exchange.tracePage.total
          ? { ...previous, exchange: { ...previous.exchange, ...page.exchange } }
          : await fetchTrafficExchange(current, signal)
      } else {
        snapshot.current = null
        value = await fetchTrafficExchange(current, signal)
      }
    } catch (error) {
      if (!signal?.aborted && error instanceof ApiClientError && trafficMissingCodes.includes(error.code)) {
        owner.missing = true
        snapshot.current = null
      }
      throw error
    }
    if (!signal?.aborted) {
      snapshot.current = value
      owner.target = { label: value.label, session: value.session, id: value.exchange.id }
      owner.missing = false
    }
    return { key, value }
  }, [key, identity])
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const result = useApi(load, [key])
  const owner = anchor.current?.key === identity ? anchor.current : null
  const resolved = query === null ? null : { ...query, ...owner?.target }
  const scope = JSON.stringify(resolved === null ? null : { label: resolved.label, session: resolved.session, detail: true })
  const watch = useCallback((signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchTraffic(JSON.parse(scope), signal, receive), [scope])
  const history = (query?.traceOffset ?? 0) > 0
  const status = useQueueEvents(result.refetch, result.loading, query !== null && !history, latest, read, query === null ? null : watch, true)
  const unavailable = owner?.missing === true || result.error !== null && trafficMissingCodes.includes(result.errorCode ?? "")
  const data = unavailable ? null : resolveTrafficData(key, result.data)
  return { ...result, data,
    refetch: () => {
      snapshot.current = null
      result.refetch()
    },
    displayData: unavailable ? null : data ?? resolveTrafficDetailSnapshot(resolved, result.data?.value ?? null),
    loading: query !== null && result.error === null && data === null,
    refreshing: result.loading,
    notificationStatus: history ? "paused" as const : status,
  }
}

const trafficMissingCodes = ["traffic_exchange_not_found", "traffic_session_not_found", "traffic_label_not_found", "traffic_unavailable"]
