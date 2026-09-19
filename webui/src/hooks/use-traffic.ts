import { useRef } from "react"

import { useApi } from "@/hooks/use-api"
import { fetchTrafficExchange, fetchTrafficExchanges, fetchTrafficTrace } from "@/lib/api"
import { resolveTrafficData, resolveTrafficDetailSnapshot } from "@/lib/traffic-state"
import type { TrafficDetailResponse } from "@/lib/types"

export function useTrafficExchanges(
  query: { label?: string; limit?: number; offset?: number; session?: string } | null,
) {
  const key = JSON.stringify(query)
  const result = useApi(
    async (signal) => ({ key, value: query === null ? null : await fetchTrafficExchanges(query, signal) }),
    [key],
  )
  // useApi 刷新期间保留旧值；旧查询结果不得参与当前地址的 label/session 补全。
  return { ...result, data: resolveTrafficData(key, result.data) }
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
      if (previous !== null) {
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
