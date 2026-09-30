import { useCallback, useEffect, useRef, useState } from "react"

import { ApiClientError } from "@/lib/api"
import { scheduleApiRefresh } from "../lib/api-polling"

export interface UseApiState<T> {
  data: T | null
  loading: boolean
  error: string | null
  errorCode: string | null
}

export function useApi<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  { retainDataOnError = true }: { retainDataOnError?: boolean } = {},
): UseApiState<T> & { refetch: () => void; replaceData: (data: T) => void } {
  const [state, setState] = useState<UseApiState<T>>({
    data: null,
    loading: true,
    error: null,
    errorCode: null,
  })
  const activeRequest = useRef<AbortController | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setState((previous) => ({ ...previous, loading: true, error: null, errorCode: null }))
    loader(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ data, loading: false, error: null, errorCode: null })
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState((previous) => ({
            data: retainDataOnError ? previous.data : null,
            loading: false,
            errorCode: error instanceof ApiClientError ? error.code
              : error instanceof Error && error.name === "TimeoutError" ? "request_timeout"
              : error instanceof TypeError ? "network_error" : "unknown",
            error: error instanceof Error ? error.message : String(error),
          }))
        }
      })
    return () => controller.abort()
    // loader 由调用方按 deps 稳定；这里只追踪数据依赖与手动刷新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, reloadKey, retainDataOnError])

  const refetch = useCallback(() => {
    activeRequest.current?.abort()
    setState((previous) => ({ ...previous, loading: true, error: null, errorCode: null }))
    setReloadKey((key) => key + 1)
  }, [])
  const replaceData = useCallback((data: T) => {
    activeRequest.current?.abort()
    setState({ data, loading: false, error: null, errorCode: null })
  }, [])
  return { ...state, refetch, replaceData }
}

/** 自动刷新只在请求结束后计时，不取消正在执行的请求。 */
export function useApiPolling(refetch: () => void, loading: boolean, enabled: boolean) {
  useEffect(() => scheduleApiRefresh(refetch, loading, enabled, document), [refetch, loading, enabled])
}
