import { useCallback, useEffect, useRef, useState } from "react"
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
  const active = useRef<AbortController | null>(null)
  const current = useRef({ key, enabled })
  current.current = { key, enabled }
  const invalidate = useCallback(() => {
    active.current?.abort()
    active.current = null
    setState(null)
  }, [])
  useEffect(() => {
    invalidate()
    return () => { active.current?.abort(); active.current = null }
  }, [key, enabled, invalidate])

  const start = async () => {
    if (!enabled || input === null || active.current !== null) return
    const controller = new AbortController()
    active.current = controller
    const initial: ProbeState = { key, running: true, cancelled: false, result: null, errorCode: null }
    setState(initial)
    const owns = () => active.current === controller && current.current.enabled && current.current.key === key
    try {
      const result = await probeManagementProviderWebSearch(input, controller.signal)
      if (owns() && !controller.signal.aborted) {
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
      if (owns() && !controller.signal.aborted) setState({ ...initial, running: false,
        errorCode: error instanceof ApiClientError ? error.code : "custom_model_probe_failed" })
    } finally {
      if (active.current === controller) active.current = null
    }
  }
  const cancel = () => {
    active.current?.abort()
    active.current = null
    setState(previous => previous === null ? null : { ...previous, running: false, cancelled: true, result: null, errorCode: null })
  }
  const bound = enabled && state?.key === key ? state : null
  return { state: bound, running: bound?.running === true, start, cancel, invalidate }
}
