import { useCallback, useEffect, useRef, useState } from "react"
import { updateRelayCatalog } from "@/lib/api"
import type { RelayManagementSnapshot } from "@/lib/types"

export function useRelayCatalog({ snapshot, blocked, onRefresh, onSuccess }: {
  snapshot: RelayManagementSnapshot
  blocked: boolean
  onRefresh?: () => void
  onSuccess: () => void
}) {
  const [downloading, setDownloading] = useState(false)
  const [downloadMessage, setDownloadMessage] = useState<"error" | "auditFailed" | null>(null)
  const controller = useRef<AbortController | null>(null)
  const autoAttempted = useRef(false)
  useEffect(() => () => {
    controller.current?.abort()
    controller.current = null
    autoAttempted.current = false
  }, [])
  const download = useCallback(async () => {
    if (blocked || controller.current) return
    const active = new AbortController()
    controller.current = active
    setDownloading(true)
    setDownloadMessage(null)
    try {
      const result = await updateRelayCatalog(active.signal)
      if (!active.signal.aborted) {
        if (result.auditStatus === "failed") setDownloadMessage("auditFailed")
        else onSuccess()
        onRefresh?.()
      }
    } catch {
      if (!active.signal.aborted) setDownloadMessage("error")
    } finally {
      if (controller.current === active) controller.current = null
      if (!active.signal.aborted) setDownloading(false)
    }
  }, [blocked, onRefresh, onSuccess])
  const hasCline = snapshot.providers.some(provider => provider.id.startsWith("clp-"))
  useEffect(() => {
    if (blocked || !hasCline || snapshot.clineCatalog?.status !== "missing" || autoAttempted.current) return
    autoAttempted.current = true
    void download()
  }, [blocked, hasCline, snapshot.clineCatalog?.status, download])
  return { downloading, downloadMessage, download }
}
