import { useCallback, useState } from "react"
import { useScopedProbeRequest } from "@/hooks/use-scoped-probe-request"
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
  const reset = useCallback(() => setState(null), [])
  const request = useScopedProbeRequest(draftKey, enabled, reset)

  const start = async (index: number, input: ManagementCustomModelProbeInput) => {
    const controller = request.begin()
    if (controller === null) return
    const initial: ProbeState = { draftKey, index, capability: input.capability, result: null, errorCode: null, running: true, cancelled: false }
    setState(initial)
    try {
      const result = await probeManagementCustomModel(input, controller.signal)
      if (request.owns(controller)) {
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
  const bound = enabled && state?.draftKey === draftKey ? state : null
  const result = bound?.result
  const canApply = result?.status === "completed"
    && result.capability !== "webSearch"
    && (result.check.status === "supported" || result.check.status === "unsupported")
  return { state: bound, running: bound?.running === true, start, cancel, invalidate: request.invalidate, canApply }
}
