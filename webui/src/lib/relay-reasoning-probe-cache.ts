import type { RelayReasoningProbeMode, RelayReasoningProbeResult } from "@/lib/types"

export const relayReasoningProbeModes = ["passthrough", "off-reasoning-effort", "off-reasoning-enabled", "off-reasoning-effort-field", "off-thinking", "off-enable-thinking"] as const satisfies readonly RelayReasoningProbeMode[]

const storageKey = "codex-webui:relay-reasoning-probes:v1"
const maximumEntries = 20
const maximumBytes = 128 * 1024
const maximumAgeMs = 7 * 24 * 60 * 60 * 1000

export type RelayProbeCacheIssue = "unavailable" | "invalid"
interface CacheSnapshot {
  results: RelayReasoningProbeResult[]
  issue: RelayProbeCacheIssue | null
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function nullableCount(value: unknown): boolean {
  return value === null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** Storage and network results cross separate trust boundaries; retain metadata only. */
export function validRelayProbeResult(value: unknown): value is RelayReasoningProbeResult {
  if (!record(value) || !exactKeys(value, ["model", "protocol", "revision", "observedAtMs", "rows", "stoppedReason"])
    || typeof value.model !== "string" || value.model.length === 0 || value.model.length > 265
    || !/^[A-Za-z0-9_-]{1,64}\/[^\p{Cc}\p{Cf}\p{Cs}]{1,200}$/u.test(value.model)
    || value.model.length - value.model.indexOf("/") - 1 > 200
    || value.model.slice(value.model.indexOf("/") + 1).trim() !== value.model.slice(value.model.indexOf("/") + 1)
    || value.protocol !== "chat" && value.protocol !== "responses"
    || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/u.test(value.revision)
    || typeof value.observedAtMs !== "number" || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs <= 0 || value.observedAtMs > 8_640_000_000_000_000
    || ![null, "timeout", "material_changed"].includes(value.stoppedReason as null | string)
    || !Array.isArray(value.rows) || value.rows.length !== relayReasoningProbeModes.length) return false
  return value.rows.every((candidate: unknown, index: number) => {
    if (!record(candidate) || !exactKeys(candidate, ["mode", "status", "httpStatus", "reasoningText", "reasoningTokens", "outputTokens", "responseModel"])) return false
    return candidate.mode === relayReasoningProbeModes[index]
      && ["completed", "incomplete", "failed", "timeout", "not_run"].includes(candidate.status as string)
      && (candidate.httpStatus === null || typeof candidate.httpStatus === "number" && Number.isInteger(candidate.httpStatus) && candidate.httpStatus >= 100 && candidate.httpStatus <= 599)
      && (candidate.reasoningText === null || typeof candidate.reasoningText === "boolean")
      && nullableCount(candidate.reasoningTokens) && nullableCount(candidate.outputTokens)
      && (candidate.responseModel === null || typeof candidate.responseModel === "string" && candidate.responseModel.length <= 512)
      && (candidate.status !== "not_run" || [candidate.httpStatus, candidate.reasoningText, candidate.reasoningTokens, candidate.outputTokens, candidate.responseModel].every(value => value === null))
  })
}

export function completeRelayProbeResult(result: RelayReasoningProbeResult): boolean {
  return result.stoppedReason === null && result.rows.every(row => row.status !== "not_run")
}

export function recentRelayProbeResult(result: RelayReasoningProbeResult, now: number): boolean {
  return result.observedAtMs <= now + 5 * 60 * 1000 && result.observedAtMs >= now - maximumAgeMs
}

export function readRelayProbeCache(now: number): CacheSnapshot {
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (raw === null) return { results: [], issue: null }
    if (raw.length > maximumBytes || new TextEncoder().encode(raw).byteLength > maximumBytes) return { results: [], issue: "invalid" }
    let value: unknown
    try { value = JSON.parse(raw) } catch { return { results: [], issue: "invalid" } }
    if (!record(value) || !exactKeys(value, ["version", "results"]) || value.version !== 1
      || !Array.isArray(value.results) || value.results.length > maximumEntries) return { results: [], issue: "invalid" }
    const seen = new Set<string>()
    for (const result of value.results) {
      if (!validRelayProbeResult(result) || !completeRelayProbeResult(result)) return { results: [], issue: "invalid" }
      const key = JSON.stringify([result.model, result.protocol])
      if (seen.has(key)) return { results: [], issue: "invalid" }
      seen.add(key)
    }
    const results = (value.results as RelayReasoningProbeResult[]).filter(result => recentRelayProbeResult(result, now))
    if (results.length !== value.results.length) {
      try { window.localStorage.setItem(storageKey, JSON.stringify({ version: 1, results })) }
      catch { return { results, issue: "unavailable" } }
    }
    return { results, issue: null }
  } catch {
    return { results: [], issue: "unavailable" }
  }
}

export function saveRelayProbeCache(result: RelayReasoningProbeResult, now: number): CacheSnapshot {
  const snapshot = readRelayProbeCache(now)
  // Do not silently overwrite corrupt or unsupported data. Explicit clearing is available in the UI.
  if (snapshot.issue) return snapshot
  if (!validRelayProbeResult(result) || !completeRelayProbeResult(result) || !recentRelayProbeResult(result, now)) return { ...snapshot, issue: "invalid" }
  const previous = snapshot.results.find(previous => previous.model === result.model && previous.protocol === result.protocol)
  const latest = previous && previous.observedAtMs > result.observedAtMs ? previous : result
  const results = [latest, ...snapshot.results.filter(previous => previous.model !== result.model || previous.protocol !== result.protocol)]
    .sort((left, right) => right.observedAtMs - left.observedAtMs).slice(0, maximumEntries)
  try {
    let raw = JSON.stringify({ version: 1, results })
    while (new TextEncoder().encode(raw).byteLength > maximumBytes && results.length > 1) {
      results.pop()
      raw = JSON.stringify({ version: 1, results })
    }
    if (new TextEncoder().encode(raw).byteLength > maximumBytes) return { ...snapshot, issue: "invalid" }
    window.localStorage.setItem(storageKey, raw)
    return { results, issue: null }
  } catch {
    return { ...snapshot, issue: "unavailable" }
  }
}

export function clearRelayProbeCache(): boolean {
  try {
    window.localStorage.removeItem(storageKey)
    return true
  } catch {
    return false
  }
}

export function isRelayProbeCacheEvent(event: StorageEvent): boolean {
  return event.key === storageKey || event.key === null
}
