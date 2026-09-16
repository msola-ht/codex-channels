import { useEffect, useRef, useState } from "react"
import { fetchMetricsExport } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useMetricsExport(query: MetricsQuery) {
  const controller = useRef<AbortController | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const download = async () => {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setPending(true)
    setError(null)
    try {
      const result = await fetchMetricsExport(query, request.signal)
      if (request.signal.aborted) return
      const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = "request-metrics.json"
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : "导出失败")
    } finally {
      if (!request.signal.aborted) setPending(false)
    }
  }
  return { download, pending, error }
}
