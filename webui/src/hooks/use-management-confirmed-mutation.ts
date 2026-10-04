import { useCallback, useEffect, useRef, useState } from "react"

import { ApiClientError } from "@/lib/api"
import { useApi } from "@/hooks/use-api"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiError, translateApiErrorCode } from "@/lib/i18n/translate"

export interface PendingManagementMutation<Input, Preview> {
  input: Input
  preview: Preview
  confirmationToken: string
}

export function useManagementConfirmedMutation<Snapshot, Input, Preview, Result>({
  load,
  preview,
  apply,
  retainDataOnError = true,
}: {
  load: (signal?: AbortSignal) => Promise<Snapshot>
  preview: (input: Input, signal?: AbortSignal) => Promise<{ preview: Preview; confirmationToken: string }>
  apply: (input: Input, confirmationToken: string, signal: AbortSignal | undefined, preview: Preview) => Promise<Result>
  retainDataOnError?: boolean
}) {
  const request = useApi(load, [], { retainDataOnError })
  const { t } = useTranslation()
  const { refetch } = request
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  const [busy, setBusy] = useState(false)
  const [actionErrorCode, setActionErrorCode] = useState<string | null>(null)
  const [pendingPreview, setPendingPreview] = useState<PendingManagementMutation<Input, Preview> | null>(null)

  useEffect(() => { if (request.error !== null && operation.current === null) setPendingPreview(null) }, [request.error, busy])

  const mutate = useCallback(async (input: Input) => {
    if (pendingPreview !== null || operation.current !== null || busy || request.loading || request.error !== null) return null
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setActionErrorCode(null)
    try {
      const result = await preview(input, controller.signal)
      if (controller.signal.aborted) return null
      setPendingPreview({ input, preview: result.preview, confirmationToken: result.confirmationToken })
      return null
    } catch (error) {
      if (controller.signal.aborted) return null
      setPendingPreview(null)
      setActionErrorCode(error instanceof ApiClientError ? error.code ?? "unknown" : "unknown")
      return null
    } finally {
      if (operation.current === controller) {
        operation.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }, [pendingPreview, preview, busy, request.loading, request.error])

  const confirm = useCallback(async () => {
    const pending = pendingPreview
    if (pending === null || operation.current !== null || busy || request.loading || request.error !== null) return null
    const controller = new AbortController()
    operation.current = controller
    setBusy(true)
    setActionErrorCode(null)
    try {
      const result = await apply(pending.input, pending.confirmationToken, controller.signal, pending.preview)
      if (controller.signal.aborted) return null
      setPendingPreview(null)
      refetch()
      return result
    } catch (error) {
      if (controller.signal.aborted) return null
      setPendingPreview(null)
      setActionErrorCode(error instanceof ApiClientError ? error.code ?? "unknown" : "unknown")
      return null
    } finally {
      if (operation.current === controller) {
        operation.current = null
        if (!controller.signal.aborted) setBusy(false)
      }
    }
  }, [apply, pendingPreview, refetch, busy, request.loading, request.error])

  const cancel = useCallback(() => {
    if (operation.current !== null || busy) return
    setPendingPreview(null)
    setActionErrorCode(null)
  }, [busy])

  const clearError = useCallback(() => { setActionErrorCode(null) }, [])
  return {
    ...request,
    error: translateApiError(t, request.error, request.errorCode),
    busy,
    pendingPreview,
    actionError: actionErrorCode === null ? null : translateApiErrorCode(t, actionErrorCode),
    actionErrorCode,
    mutate,
    confirm,
    cancel,
    clearError,
  }
}
