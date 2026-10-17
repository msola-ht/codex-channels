import { useCallback, useEffect, useRef, useState } from "react"
import { ApiClientError, probeManagementCustomModel } from "@/lib/api"
import type { ManagementCustomModelProbeInput, ManagementCustomModelProbeResult } from "@/lib/types"

interface ProbeState {
  draftKey: string
  index: number
  capability: ManagementCustomModelProbeInput["capability"]
  result: ManagementCustomModelProbeResult | null
  errorCode: string | null
  running: boolean
  cancelled: boolean
}

export function useCustomModelCapabilityProbe(draftKey: string, enabled: boolean) {
  const [state, setState] = useState<ProbeState | null>(null)
  const active = useRef<AbortController | null>(null)
  const current = useRef({ draftKey, enabled })
  current.current = { draftKey, enabled }

  const invalidate = useCallback(() => {
    active.current?.abort()
    active.current = null
    setState(null)
  }, [])
  useEffect(() => {
    invalidate()
    return () => {
      active.current?.abort()
      active.current = null
    }
  }, [draftKey, enabled, invalidate])

  const start = async (index: number, input: ManagementCustomModelProbeInput) => {
    if (!enabled || active.current !== null) return
    const controller = new AbortController()
    active.current = controller
    const initial: ProbeState = { draftKey, index, capability: input.capability, result: null, errorCode: null, running: true, cancelled: false }
    setState(initial)
    const owns = () => active.current === controller && current.current.enabled && current.current.draftKey === draftKey
    try {
      const result = await probeManagementCustomModel(input, controller.signal)
      if (owns() && !controller.signal.aborted) {
        if (result.model !== input.model || result.upstreamWireApi !== input.upstreamWireApi
          || result.capability !== input.capability || result.reasoningEffort !== input.reasoningEffort
          || result.check?.capability !== input.capability
          || !["supported", "unsupported", "inconclusive"].includes(result.check.status)
          || !["completed", "cancelled"].includes(result.status)
          || (input.capability === "webSearch"
            ? result.connectionToken !== undefined
            : !/^[a-f0-9]{64}$/.test(result.connectionToken ?? ""))) {
          setState({ ...initial, running: false, errorCode: "custom_model_probe_failed" })
        } else {
          setState({ ...initial, running: false, result })
        }
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
  const bound = enabled && state?.draftKey === draftKey ? state : null
  const result = bound?.result
  const canApply = result?.status === "completed"
    && result.capability !== "webSearch"
    && (result.check.status === "supported" || result.check.status === "unsupported")
  return { state: bound, running: bound?.running === true, start, cancel, invalidate, canApply }
}
