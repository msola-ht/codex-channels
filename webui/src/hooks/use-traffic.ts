import { useRef } from "react"

import { useApi } from "@/hooks/use-api"
import { fetchTrafficExchange, fetchTrafficExchanges, fetchTrafficTrace, fetchTrafficTurnStates } from "@/lib/api"
import { canReuseTrafficSummary, resolveTrafficData, resolveTrafficDetailSnapshot, trafficCallKey } from "@/lib/traffic-state"
import type { TrafficDetailResponse, TrafficListResponse } from "@/lib/types"

export function useTrafficExchanges(
  query: { label?: string; limit?: number; offset?: number; session?: string } | null,
) {
  const successfulCounts = useRef<{
    source: TrafficListResponse | null
    entries: Map<string, Array<{ source: string; characters: number }>>
  }>({ source: null, entries: new Map() })
  const key = JSON.stringify(query)
  const result = useApi(
    async (signal) => ({ key, value: query === null ? null : await fetchTrafficExchanges(query, signal) }),
    [key],
  )
  // useApi 刷新期间保留旧值；旧查询结果不得参与当前地址的 label/session 补全。
  const data = resolveTrafficData(key, result.data)
  const source = result.loading || result.error !== null ? null : data
  const lengths = useApi(async (signal) => {
    if (successfulCounts.current.source !== source) successfulCounts.current = { source, entries: new Map() }
    const entries = new Map(successfulCounts.current.entries)
    const errors = new Map<string, string>()
    const failedBatches: string[] = []
    if (source === null) return { source, entries, errors, error: null }
    const batches = new Map<string, { label: string; session: string; ids: number[] }>()
    for (const exchange of source.exchanges) {
      const batchKey = JSON.stringify([exchange.label, exchange.session])
      const batch = batches.get(batchKey) ?? { label: exchange.label, session: exchange.session, ids: [] }
      batch.ids.push(exchange.id)
      batches.set(batchKey, batch)
    }
    // 顺序读取批次，避免一次打开多个大轨迹扫描；切页由 useApi 取消客户端请求。
    for (const batch of batches.values()) {
      signal.throwIfAborted()
      if (batch.ids.every((id) => entries.has(trafficCallKey({ ...batch, id })))) continue
      try {
        const response = await fetchTrafficTurnStates(batch, signal)
        signal.throwIfAborted()
        for (const exchange of response.exchanges) {
          entries.set(trafficCallKey({ ...response, id: exchange.id }), exchange.turnStateLengths)
        }
        successfulCounts.current = { source, entries: new Map(entries) }
      } catch (error) {
        if (signal.aborted) throw error
        const message = error instanceof Error ? error.message : String(error)
        failedBatches.push(`${batch.label} / ${batch.session}`)
        for (const id of batch.ids) errors.set(trafficCallKey({ ...batch, id }), message)
      }
    }
    return { source, entries, errors, error: failedBatches.length === 0 ? null : `${failedBatches.length} 个批次读取失败：${failedBatches.join("；")}` }
  }, [source])
  const currentLengths = source !== null && lengths.data?.source === source ? lengths.data : null
  return { ...result, data,
    turnStates: currentLengths?.entries,
    turnStateErrors: lengths.loading ? undefined : currentLengths?.errors,
    turnStatesLoading: source !== null && (lengths.loading || currentLengths === null),
    turnStatesError: currentLengths?.error ?? null,
    refetchTurnStates: lengths.refetch,
  }
}

export function useTrafficExchange(
  query: { traceOffset?: number; id: number; label?: string; session?: string } | null,
) {
  const snapshot = useRef<TrafficDetailResponse | null>(null)
  const key = JSON.stringify(query)
  const result = useApi(
    async (signal) => {
      if (query === null) {
        snapshot.current = null
        return { key, value: null }
      }
      const previous = resolveTrafficDetailSnapshot(query, snapshot.current)
      let value: TrafficDetailResponse
      if (previous !== null && canReuseTrafficSummary(previous.exchange)) {
        const page = await fetchTrafficTrace({
          ...query, label: previous.label, session: previous.session,
        }, signal)
        value = { ...previous, exchange: { ...previous.exchange, ...page.exchange } }
      } else {
        snapshot.current = null
        value = await fetchTrafficExchange(query, signal)
      }
      if (!signal.aborted) snapshot.current = value
      return { key, value }
    },
    [key],
  )
  const data = resolveTrafficData(key, result.data)
  return { ...result, data,
    refetch: () => {
      snapshot.current = null
      result.refetch()
    },
    displayData: data ?? resolveTrafficDetailSnapshot(query, result.data?.value ?? null),
    loading: result.loading || (query !== null && result.error === null && data === null),
  }
}
