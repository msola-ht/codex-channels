import { useCallback, useState } from "react"
import { useScopedProbeRequest } from "@/hooks/use-scoped-probe-request"
import { ApiClientError, probeManagementProviderWebSearch } from "@/lib/api"
import type { ManagementProviderWebSearchProbeInput, ManagementProviderWebSearchProbeResult } from "@/lib/types"

interface ProbeState {
  key: string
  running: boolean
  cancelled: boolean
  result: ManagementProviderWebSearchProbeResult | null
  errorCode: string | null
}

export function useProviderWebSearchProbe(input: ManagementProviderWebSearchProbeInput | null, enabled: boolean) {
  const key = JSON.stringify(input)
  const [state, setState] = useState<ProbeState | null>(null)
  const reset = useCallback(() => setState(null), [])
  const request = useScopedProbeRequest(key, enabled, reset)

  const start = async () => {
    if (input === null) return
    const controller = request.begin()
    if (controller === null) return
    const initial: ProbeState = { key, running: true, cancelled: false, result: null, errorCode: null }
    setState(initial)
    try {
      const result = await probeManagementProviderWebSearch(input, controller.signal)
      if (request.owns(controller)) {
        if (result.provider !== input.provider || result.model !== input.model
          || result.capability !== "webSearch" || result.check?.capability !== "webSearch"
          || !["responses", "chat_completions"].includes(result.upstreamWireApi)
          || !["supported", "unsupported", "inconclusive"].includes(result.check.status)
          || !["completed", "cancelled"].includes(result.status)
          || Object.hasOwn(result, "connectionToken")) {
          setState({ ...initial, running: false, errorCode: "custom_model_probe_failed" })
        } else setState({ ...initial, running: false, result })
      }
    } catch (error) {
      if (request.owns(controller)) setState({ ...initial, running: false,
        errorCode: error instanceof ApiClientError ? error.code : "custom_model_probe_failed" })
    } finally {
      request.finish(controller)
    }
  }
  const cancel = () => {
    request.cancel()
    setState(previous => previous === null ? null : { ...previous, running: false, cancelled: true, result: null, errorCode: null })
  }
  const bound = enabled && state?.key === key ? state : null
  return { state: bound, running: bound?.running === true, start, cancel, invalidate: request.invalidate }
}
