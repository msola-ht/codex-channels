import { useEffect, useRef, useState } from "react"
import { ApiClientError, probeRelayReasoning } from "@/lib/api"
import { useServerTimeSnapshot } from "@/hooks/use-server-time"
import { estimateServerTime } from "@/lib/server-time"
import { clearRelayProbeCache, completeRelayProbeResult, isRelayProbeCacheEvent, readRelayProbeCache, recentRelayProbeResult, relayReasoningProbeModes, saveRelayProbeCache, validRelayProbeResult } from "@/lib/relay-reasoning-probe-cache"
import type { RelayProbeCacheIssue } from "@/lib/relay-reasoning-probe-cache"
import type { RelayReasoningProbeInput, RelayReasoningProbeMode, RelayReasoningProbeResult, RelayReasoningProbeRow } from "@/lib/types"

interface ProbeState {
  contextKey: string
  running: boolean
  cancelled: boolean
  errorCode: string | null
  result: RelayReasoningProbeResult | null
  currentMode: RelayReasoningProbeMode | null
  final: boolean
}

interface HistoryState {
  key: string
  result: RelayReasoningProbeResult | null
  issue: RelayProbeCacheIssue | null
}

export function useRelayReasoningProbe(input: RelayReasoningProbeInput, editorScope: string, enabled: boolean) {
  const clock = useServerTimeSnapshot()
  const contextKey = JSON.stringify([editorScope, input.revision, input.model, input.protocol])
  const historyKey = JSON.stringify([input.model, input.protocol])
  const [state, setState] = useState<ProbeState | null>(null)
  const [historyState, setHistoryState] = useState<HistoryState | null>(null)
  const [cacheCleared, setCacheCleared] = useState(false)
  const active = useRef<AbortController | null>(null)
  const current = useRef({ contextKey, enabled, clock })
  current.current = { contextKey, enabled, clock }

  useEffect(() => {
    setState(previous => previous?.running ? { ...previous, running: false, cancelled: true, currentMode: null, final: false } : previous)
    return () => {
      active.current?.abort()
      active.current = null
    }
  }, [contextKey, enabled])

  useEffect(() => {
    const load = () => {
      const snapshot = readRelayProbeCache(estimateServerTime(clock))
      setHistoryState({ key: historyKey, result: snapshot.results.find(result => result.model === input.model && result.protocol === input.protocol) ?? null, issue: snapshot.issue })
      setCacheCleared(false)
    }
    load()
    const onStorage = (event: StorageEvent) => { if (isRelayProbeCacheEvent(event)) load() }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [historyKey, input.model, input.protocol, clock])

  const bound = state?.contextKey === contextKey ? state : null
  const history = historyState?.key === historyKey ? historyState.result : null
  const materialChanged = bound?.result?.stoppedReason === "material_changed" || bound?.errorCode === "stale-revision"

  const start = async () => {
    if (!enabled || !input.revision || materialChanged || active.current !== null) return
    const controller = new AbortController()
    active.current = controller
    const initial: ProbeState = { contextKey, running: true, cancelled: false, errorCode: null, result: null, currentMode: null, final: false }
    setState(initial)
    setCacheCleared(false)
    const owns = () => active.current === controller && !controller.signal.aborted
      && current.current.enabled && current.current.contextKey === contextKey
    const matches = (value: unknown): value is RelayReasoningProbeResult => validRelayProbeResult(value)
      && value.model === input.model && value.protocol === input.protocol && value.revision === input.revision
    let latest: RelayReasoningProbeResult | null = null
    try {
      const result = await probeRelayReasoning(input, controller.signal, event => {
        if (!owns()) return
        if (!matches(event.result) || event.currentMode !== null && !relayReasoningProbeModes.includes(event.currentMode)) throw new ApiClientError("", 502, "relay_probe_failed")
        latest = event.result
        setState({ ...initial, result: latest, currentMode: event.currentMode })
      })
      if (owns()) {
        if (!matches(result)) throw new ApiClientError("", 502, "relay_probe_failed")
        latest = result
        setState({ ...initial, running: false, result, final: true })
        if (completeRelayProbeResult(result)) {
          const snapshot = saveRelayProbeCache(result, estimateServerTime(current.current.clock))
          setHistoryState(previous => ({ key: historyKey,
            result: snapshot.results.find(previous => previous.model === input.model && previous.protocol === input.protocol)
              ?? (snapshot.issue && previous?.key === historyKey ? previous.result : null), issue: snapshot.issue }))
        }
      }
    } catch (error) {
      if (owns()) setState({ ...initial, running: false, result: latest,
        errorCode: error instanceof ApiClientError ? error.code : error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "relay_probe_failed" })
    } finally {
      if (active.current === controller) active.current = null
    }
  }

  const cancel = () => {
    active.current?.abort()
    active.current = null
    setState(previous => previous?.contextKey === contextKey && previous.running
      ? { ...previous, running: false, cancelled: true, errorCode: null, currentMode: null, final: false } : previous)
  }
  const clearHistory = () => {
    const cleared = clearRelayProbeCache()
    setCacheCleared(cleared)
    if (cleared) setHistoryState({ key: historyKey, result: null, issue: null })
    else setHistoryState(previous => ({ key: historyKey, result: previous?.key === historyKey ? previous.result : null, issue: "unavailable" }))
  }
  const canApply = (row: RelayReasoningProbeRow, result: RelayReasoningProbeResult) => {
    const fromCurrent = bound?.result === result && bound.final && !bound.cancelled && !bound.errorCode && completeRelayProbeResult(result)
    const fromHistory = result === history
    return enabled && current.current.enabled && current.current.contextKey === contextKey && active.current === null
      && !bound?.running && !materialChanged && result.revision === input.revision && (fromCurrent || fromHistory)
      && recentRelayProbeResult(result, estimateServerTime(current.current.clock))
      && result.rows.includes(row) && row.mode !== "passthrough" && row.status === "completed"
      && row.httpStatus !== null && row.httpStatus >= 200 && row.httpStatus < 300
  }
  return {
    state: bound, history, cacheIssue: historyState?.key === historyKey ? historyState.issue : null, cacheCleared,
    running: enabled && bound?.running === true, start, cancel, clearHistory, canApply, materialChanged,
    revisionChanged: materialChanged || history !== null && history.revision !== input.revision,
    completedCount: bound?.result?.rows.filter(row => row.status !== "not_run").length ?? 0,
    totalCount: relayReasoningProbeModes.length,
  }
}
