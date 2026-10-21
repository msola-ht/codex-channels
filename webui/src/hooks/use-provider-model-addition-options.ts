import { useCallback, useEffect, useRef, useState } from "react"
import { ApiClientError, fetchProviderModelAdditionOptions } from "@/lib/api"
import type { ManagedManualModelDefinition, ProviderModelAdditionOptions } from "../../../scripts/provider-model-additions.mjs"

interface CandidateState {
  key: string
  options: ProviderModelAdditionOptions | null
  selected: string[]
  loading: boolean
  errorCode: string | null
}

/** Candidates are fetched only on demand; hiding for confirmation preserves the loaded choice. */
export function useProviderModelAdditionOptions(target: { provider: string; revision: string }, open: boolean, stale: boolean, busy: boolean) {
  const key = JSON.stringify([target.provider, target.revision])
  const [state, setState] = useState<CandidateState | null>(null)
  const active = useRef<AbortController | null>(null)
  const current = useRef({ key, open, stale, busy })
  current.current = { key, open, stale, busy }
  const cancel = useCallback(() => {
    const controller = active.current
    active.current = null
    controller?.abort()
  }, [])
  const reset = useCallback(() => {
    cancel()
    setState(null)
  }, [cancel])
  useEffect(() => {
    reset()
    return cancel
  }, [key, stale, reset, cancel])
  useEffect(() => {
    if (!open) {
      cancel()
      setState(previous => previous === null ? null : { ...previous, loading: false })
    }
  }, [open, cancel])

  const load = async (manualModel?: ManagedManualModelDefinition) => {
    if (active.current !== null || !current.current.open || current.current.stale || current.current.busy || current.current.key !== key) return
    const controller = new AbortController()
    active.current = controller
    const initial: CandidateState = { key, options: null, selected: [], loading: true, errorCode: null }
    setState(initial)
    const owns = () => active.current === controller && !controller.signal.aborted
      && current.current.key === key && current.current.open && !current.current.stale
    try {
      const options = await fetchProviderModelAdditionOptions(target.provider, manualModel, controller.signal)
      if (owns()) setState({ ...initial, options, loading: false, selected: manualModel ? options.candidates.map(entry => entry.model) : [] })
    } catch (cause) {
      if (owns()) setState({ ...initial, loading: false, errorCode: cause instanceof ApiClientError ? cause.code : "network_error" })
    } finally {
      if (active.current === controller) active.current = null
    }
  }
  const bound = state?.key === key && !stale ? state : null
  const setSelected = (update: (previous: string[]) => string[]) => setState(previous => previous?.key === key
    ? { ...previous, selected: update(previous.selected) } : previous)
  const clearError = () => setState(previous => previous?.key === key ? { ...previous, errorCode: null } : previous)
  return { options: bound?.options ?? null, selected: bound?.selected ?? [], loading: bound?.loading === true,
    errorCode: bound?.errorCode ?? null, load, reset, setSelected, clearError }
}
