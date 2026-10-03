import { useApi, useApiPolling } from "@/hooks/use-api"
import { getServiceLogs } from "@/lib/api"
import type { ServiceLogTarget } from "@/lib/types"

export function useServiceLogs(target: ServiceLogTarget, lines: number, automatic: boolean) {
  const key = `${target}:${lines}`
  const state = useApi(async signal => ({ key, snapshot: await getServiceLogs(target, lines, signal) }), [key])
  useApiPolling(state.refetch, state.loading, automatic && state.error === null, 5000)
  return { ...state, data: state.data?.key === key ? state.data.snapshot : null }
}
