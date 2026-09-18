import { useApi } from "@/hooks/use-api"
import { fetchTrafficExchange, fetchTrafficExchanges } from "@/lib/api"
import { resolveTrafficData } from "@/lib/traffic-state"

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
  const key = JSON.stringify(query)
  const result = useApi(
    async (signal) => ({ key, value: query === null ? null : await fetchTrafficExchange(query, signal) }),
    [key],
  )
  return { ...result, data: resolveTrafficData(key, result.data) }
}
