import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react"

import { ApiClientError, fetchCloudUsage } from "@/lib/api"
import type { CloudUsageView } from "@/lib/types"

type CloudUsageRange = CloudUsageView["report"]["query"]["range"]
interface CloudUsageState {
  provider: string
  range: CloudUsageRange
  data: CloudUsageView | null
  loading: boolean
  errorCode: string | null
}

type ReadMode = "load" | "snapshot" | "refresh"
export function createCloudUsageSession() {
  interface Job { start: () => void; cancel: () => void }
  const queue: Job[] = []
  const jobs = new Set<Job>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let nextReadAt = 0
  const schedule = () => {
    if (timer || queue.length === 0) return
    timer = setTimeout(() => {
      timer = undefined
      const job = queue.shift()
      if (job) { nextReadAt = Date.now() + 1_000; job.start() }
      schedule()
    }, Math.max(0, nextReadAt - Date.now()))
  }
  return {
    snapshots: new Map<string, CloudUsageView>(), readers: new Set<(mode: ReadMode) => void>(),
    readSnapshot(provider: string, range: CloudUsageRange, signal: AbortSignal): Promise<CloudUsageView | null> {
      if (signal.aborted) return Promise.reject(signal.reason)
      if (jobs.size >= 64) return Promise.reject(new ApiClientError("Snapshot queue full", 429, "management.rate-limited"))
      return new Promise((resolve, reject) => {
        let settled = false, retries = 0
        const controller = new AbortController()
        const finish = (error: unknown, data?: CloudUsageView | null) => {
          if (settled) return
          settled = true
          controller.abort()
          signal.removeEventListener("abort", job.cancel)
          jobs.delete(job)
          const index = queue.indexOf(job)
          if (index >= 0) queue.splice(index, 1)
          if (queue.length === 0) { clearTimeout(timer); timer = undefined }
          if (error !== undefined) reject(error); else resolve(data ?? null)
        }
        const job: Job = {
          cancel: () => finish(signal.reason ?? new DOMException("Cancelled", "AbortError")),
          start: () => {
            void fetchCloudUsage(provider, range, false, controller.signal, true).then(data => finish(undefined, data), error => {
              if (!settled && error instanceof ApiClientError && error.status === 429 && retries++ === 0) {
                // Multiple browser tabs share the server quota; one bounded retry,
                // with the same caller cancellation, avoids a notification retry storm.
                nextReadAt = Date.now() + 60_000
                clearTimeout(timer); timer = undefined
                queue.push(job); schedule()
              } else finish(error)
            })
          },
        }
        jobs.add(job)
        queue.push(job)
        signal.addEventListener("abort", job.cancel, { once: true })
        if (signal.aborted) job.cancel(); else schedule()
      })
    },
    dispose() { for (const job of jobs) job.cancel(); clearTimeout(timer); timer = undefined },
  }
}
export const CloudUsageSessionContext = createContext<ReturnType<typeof createCloudUsageSession> | null>(null)

const cloudErrorCodes: Readonly<Record<string, string>> = {
  invalid_request: "cloud_usage_invalid_request",
  provider_not_found: "cloud_usage_provider_not_found",
  refresh_failed: "cloud_usage_refresh_failed",
  invalid_response: "cloud_usage_invalid_response",
  gateway_unavailable: "cloud_usage_gateway_unavailable",
}

/** Compact account estimates use the last 24 hours; refresh retains server cache limits. */
export function useCloudUsage(provider: string) {
  const session = useContext(CloudUsageSessionContext)
  const range: CloudUsageRange = "24h"
  const key = `${provider}:${range}`
  const [state, setState] = useState<CloudUsageState>(() => {
    const previous = session?.snapshots.get(key)
    const data = previous && Date.now() - previous.report.observedAtMs < 300_000 ? previous : null
    return { provider, range, data, loading: true, errorCode: null }
  })
  const active = useRef<AbortController | null>(null)
  const pendingSnapshot = useRef(false)
  const [syncRevision, setSyncRevision] = useState(0)
  const cancel = useCallback(() => {
    const controller = active.current
    active.current = null
    controller?.abort()
  }, [])
  const read = useCallback(async (mode: ReadMode) => {
    if (mode === "snapshot" && active.current) { pendingSnapshot.current = true; return }
    cancel()
    const controller = new AbortController()
    active.current = controller
    setState(previous => ({
      provider, range,
      data: previous.provider === provider && previous.range === range ? previous.data : null,
      loading: true, errorCode: null,
    }))
    try {
      const publish = (data: CloudUsageView | null, loading: boolean) => {
        if (controller.signal.aborted || active.current !== controller) return
        if (data !== null && (data.report?.provider !== provider || data.report.query?.range !== range)) {
          throw new ApiClientError("Cloud usage response scope mismatch", 502, "cloud_usage_invalid_response")
        }
        if (data) {
          if (session && session.snapshots.size >= 64 && !session.snapshots.has(key)) session.snapshots.delete(session.snapshots.keys().next().value!)
          session?.snapshots.set(key, data)
        } else session?.snapshots.delete(key)
        setState({ provider, range, data, loading, errorCode: data === null && !loading ? "cloud_usage_unavailable" : null })
      }
      if (mode !== "refresh") {
        const snapshot = await (session ? session.readSnapshot(provider, range, controller.signal)
          : fetchCloudUsage(provider, range, false, controller.signal, true))
        if (controller.signal.aborted || active.current !== controller) return
        const needsRefresh = mode === "load" && (!snapshot || snapshot.report.stale || snapshot.report.balanceStale || snapshot.report.planStale)
        publish(snapshot, needsRefresh)
        if (!needsRefresh) return
      }
      const data = await fetchCloudUsage(provider, range, mode === "refresh", controller.signal)
      if (data === null) throw new ApiClientError("Missing cloud usage response", 502, "cloud_usage_invalid_response")
      publish(data, false)
    } catch (error: unknown) {
      if (controller.signal.aborted || active.current !== controller) return
      const errorCode = error instanceof ApiClientError ? cloudErrorCodes[error.code] ?? error.code
        : error instanceof Error && error.name === "TimeoutError" ? "request_timeout"
        : error instanceof TypeError ? "network_error" : "cloud_usage_unavailable"
      // A failed authoritative account query may mean revoked credentials or a removed account.
      // Only transport failures retain a labelled presentation snapshot.
      const discard = error instanceof ApiClientError && ["provider_not_found", "refresh_failed", "invalid_response", "cloud_usage_invalid_response"].includes(error.code)
      if (discard) session?.snapshots.delete(key)
      setState(previous => ({ ...previous, data: discard ? null : previous.data, loading: false, errorCode }))
    } finally {
      if (active.current === controller) {
        active.current = null
        if (pendingSnapshot.current) { pendingSnapshot.current = false; setSyncRevision(value => value + 1) }
      }
    }
  }, [provider, range, key, session, cancel])

  useEffect(() => {
    const refresh = (mode: ReadMode) => { void read(mode) }
    session?.readers.add(refresh)
    void read("load")
    return () => { session?.readers.delete(refresh); pendingSnapshot.current = false; cancel() }
  }, [read, session, cancel])
  useEffect(() => { if (syncRevision > 0) void read("snapshot") }, [syncRevision, read])

  const current = state.provider === provider && state.range === range ? state : null
  return {
    data: current?.data ?? null,
    loading: current?.loading ?? true,
    errorCode: current?.errorCode ?? null,
    refresh: () => { void read("refresh") },
  }
}
