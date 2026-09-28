import { useEffect, useRef, useState } from "react"
import { ApiClientError, fetchMetricsExport } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useMetricsExport(query: MetricsQuery) {
  const controller = useRef<AbortController | null>(null)
  const [pending, setPending] = useState(false)
  // 导出失败只保留结构化错误码，界面按当前语言翻译，不直接展示异常正文。
  const [failure, setFailure] = useState<{ code: string | null } | null>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const download = async () => {
    controller.current?.abort()
    const request = new AbortController()
    controller.current = request
    setPending(true)
    setFailure(null)
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
      if (!request.signal.aborted) {
        setFailure({
          code: cause instanceof ApiClientError ? cause.code
            : cause instanceof Error && cause.name === "TimeoutError" ? "request_timeout"
            : cause instanceof TypeError ? "network_error" : null,
        })
      }
    } finally {
      if (!request.signal.aborted) setPending(false)
    }
  }
  return { download, pending, failed: failure !== null, errorCode: failure?.code ?? null }
}
