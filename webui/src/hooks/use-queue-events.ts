import { useEffect, useState, type RefObject } from "react"
import { ApiClientError } from "@/lib/api"
import type { QueueChangeEvent } from "@/lib/types"

/** Notification subscription survives reads and confirmations; only invalidations are deferred. */
export interface QueueSnapshotRead {
  confirmed: number
  completedAt: number
  failed: boolean
  failures: number
  retryable: boolean
  retryAt: number
}

export function useQueueEvents(refetch: () => void, loading: boolean, enabled: boolean,
  latest: RefObject<number>, read: QueueSnapshotRead | null, watch: (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => Promise<void>): "connecting" | "live" | "reconnecting" | "paused" | "retrying" | "stale" {
  const [status, setStatus] = useState<"connecting" | "live" | "reconnecting" | "paused">("connecting")
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let stopped = false
    let controller: AbortController | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let delay = 1_000
    const visible = () => document.visibilityState === "visible" && navigator.onLine
    const connect = () => {
      if (stopped || controller || !visible()) return
      clearTimeout(retry)
      retry = undefined
      const current = new AbortController()
      controller = current
      let connected = false
      void watch(current.signal, event => {
        if (stopped || current.signal.aborted) return
        connected = true
        delay = 1_000
        setStatus("live")
        if (event.type === "changed") setRevision(++latest.current)
      }).catch(error => {
        if (stopped || current.signal.aborted) return
        if (connected) setRevision(++latest.current)
        setStatus("reconnecting")
        if (error instanceof ApiClientError && [400, 401, 403].includes(error.status)) return
        retry = setTimeout(connect, delay)
        delay = Math.min(delay * 2, 30_000)
      }).finally(() => { if (controller === current) controller = undefined })
    }
    const resume = () => {
      if (!visible()) {
        clearTimeout(retry)
        controller?.abort()
        controller = undefined
        setStatus("paused")
      } else {
        setStatus(previous => previous === "live" ? previous : "connecting")
        connect()
      }
    }
    document.addEventListener("visibilitychange", resume)
    window.addEventListener("online", resume)
    window.addEventListener("offline", resume)
    resume()
    return () => {
      stopped = true
      clearTimeout(retry)
      controller?.abort()
      document.removeEventListener("visibilitychange", resume)
      window.removeEventListener("online", resume)
      window.removeEventListener("offline", resume)
    }
  }, [latest, watch])
  const needsRefresh = revision > (read?.confirmed ?? 0)
  useEffect(() => {
    if (!enabled || loading || !["live", "reconnecting"].includes(status)) return
    if (read?.failed && (!read.retryable || read.failures > 3)) return
    if (!needsRefresh && !read?.failed) return
    // Event-driven throttling, not polling: no timer remains once the snapshot catches up.
    // Reserve headroom for content reads and other management pages (120 shared reads/minute).
    const due = Math.max((read?.completedAt ?? 0) + 2_000, read?.retryAt ?? 0)
    const timer = setTimeout(refetch, Math.max(250, due - Date.now()))
    return () => clearTimeout(timer)
  }, [refetch, loading, enabled, needsRefresh, status, read])
  return status === "live" && read?.failed
    ? read.retryable && read.failures <= 3 ? "retrying" : "stale"
    : status
}
