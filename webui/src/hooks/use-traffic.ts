import { useCallback, useEffect, useRef, useState } from "react"

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
  const currentData = resolveTrafficData(key, result.data)
  const pending = (currentData?.indexStatus === "building" || currentData?.indexStatus === "ready" && currentData.indexPending) && result.error === null
  const recovery = useIndexRecovery(key, pending, result.loading, result.refetch, currentData?.indexStatus === "ready" && !pending && result.error === null)
  const scope = JSON.stringify(query === null ? null : { label: query.label, session: query.session })
  const watch = useCallback((signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchTraffic(JSON.parse(scope), signal, receive), [scope])
  const history = (query?.offset ?? 0) > 0
  const status = useQueueEvents(result.refetch, result.loading, query !== null && !history && !pending, latest, read, query === null ? null : watch, true)
  const unavailable = missingKey.current === key || result.error !== null && trafficMissingCodes.includes(result.errorCode ?? "")
  const data = unavailable ? null : resolveTrafficData(key, result.data)
  const indexError = currentData?.indexStatus === "unavailable" ? currentData.errorCode : recovery.exhausted ? "traffic_index_wait" : null
  return { ...result, data, refetch: recovery.refetch, building: pending && !recovery.exhausted,
    error: result.error ?? indexError, errorCode: result.errorCode ?? indexError,
    notificationStatus: history ? "paused" as const : status,
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
      if (previous !== null && !previous.indexPending && previous.exchange.diagnosticsComplete
        && previous.exchange.tracePage.complete && canReuseTrafficSummary(previous.exchange)) {
        const page = await fetchTrafficTrace({
          ...current, label: previous.label, session: previous.session,
        }, signal)
        // A late trace flush can add output/model evidence after the terminal index.
        // Rebuild the summary only when this call's trace changed, not for other calls in the batch.
        value = previous.exchange.tracePage.complete && page.exchange.tracePage.complete
          && previous.exchange.tracePage.total === page.exchange.tracePage.total
          ? { ...previous, indexPending: page.indexPending, exchange: { ...previous.exchange, ...page.exchange } }
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
  const pending = result.errorCode === "traffic_index_building" || result.error === null && resolveTrafficData(key, result.data)?.indexPending === true
  const recovery = useIndexRecovery(key, pending, result.loading, result.refetch, resolveTrafficData(key, result.data) !== null && !pending && result.error === null)
  const owner = anchor.current?.key === identity ? anchor.current : null
  const resolved = query === null ? null : { ...query, ...owner?.target }
  const scope = JSON.stringify(resolved === null ? null : { label: resolved.label, session: resolved.session, detail: true })
  const watch = useCallback((signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchTraffic(JSON.parse(scope), signal, receive), [scope])
  const history = (query?.traceOffset ?? 0) > 0
  const current = resolveTrafficData(key, result.data)
  // Completed details are reading snapshots. Batch notifications also include other calls;
  // late diagnostics remain available through explicit refresh without disturbing reading.
  const settled = current !== null && result.error === null && !pending && current.exchange.tracePage.complete
    && current.exchange.diagnosticsComplete && current.exchange.response !== null
    && ["completed", "failed", "incomplete"].includes(current.exchange.state)
  const paused = history || settled
  const status = useQueueEvents(result.refetch, result.loading, query !== null && !paused && !pending,
    latest, read, query === null || paused ? null : watch, true)
  const unavailable = owner?.missing === true || result.error !== null && trafficMissingCodes.includes(result.errorCode ?? "")
  const data = unavailable ? null : resolveTrafficData(key, result.data)
  return { ...result, data,
    building: pending && !recovery.exhausted,
    error: pending ? recovery.exhausted ? "traffic_index_wait" : null : result.error,
    errorCode: pending ? recovery.exhausted ? "traffic_index_wait" : null : result.errorCode,
    refetch: () => {
      snapshot.current = null
      recovery.refetch()
    },
    displayData: unavailable ? null : data ?? resolveTrafficDetailSnapshot(resolved, result.data?.value ?? null),
    loading: query !== null && result.error === null && data === null,
    refreshing: result.loading,
    notificationStatus: paused ? "paused" as const : status,
  }
}

/** Cold indexes are service-owned jobs; retry with a finite, visibility-aware budget. */
function useIndexRecovery(key: string, pending: boolean, loading: boolean, refresh: () => void, settled: boolean) {
  const attempts = useRef({ key, count: 0 })
  const [stoppedKey, setStoppedKey] = useState<string | null>(null)
  useEffect(() => {
    if (attempts.current.key !== key) { attempts.current = { key, count: 0 }; setStoppedKey(null) }
    if (settled && !loading) { attempts.current.count = 0; setStoppedKey(null) }
    if (!pending || loading || stoppedKey === key) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const schedule = () => {
      clearTimeout(timer)
      if (document.visibilityState !== "visible" || !navigator.onLine) return
      timer = setTimeout(() => {
        if (document.visibilityState !== "visible" || !navigator.onLine) return
        if (attempts.current.count >= 30) { setStoppedKey(key); return }
        attempts.current.count++
        refresh()
      }, 2_000)
    }
    schedule()
    document.addEventListener("visibilitychange", schedule)
    window.addEventListener("online", schedule)
    window.addEventListener("offline", schedule)
    return () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", schedule)
      window.removeEventListener("online", schedule)
      window.removeEventListener("offline", schedule)
    }
  }, [key, pending, loading, refresh, stoppedKey, settled])
  return { exhausted: stoppedKey === key, refetch: () => {
    attempts.current = { key, count: 0 }
    setStoppedKey(null)
    refresh()
  } }
}

const trafficMissingCodes = ["traffic_exchange_not_found", "traffic_session_not_found", "traffic_label_not_found", "traffic_unavailable"]
