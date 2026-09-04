import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"

export interface PendingManagementMutation<Input, Preview> {
  input: Input
  preview: Preview
  confirmationToken: string
}

export function useManagementConfirmedMutation<Snapshot, Input, Preview, Result>({
  load,
  preview,
  apply,
}: {
  load: (signal?: AbortSignal) => Promise<Snapshot>
  preview: (input: Input) => Promise<{ preview: Preview; confirmationToken: string }>
  apply: (input: Input, confirmationToken: string) => Promise<Result>
}) {
  const request = useApi(load, [])
  const { refetch } = request
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingPreview, setPendingPreview] = useState<PendingManagementMutation<Input, Preview> | null>(null)

  const mutate = useCallback(async (input: Input) => {
    if (pendingPreview !== null) return null
    setBusy(true)
    setActionError(null)
    try {
      const result = await preview(input)
      setPendingPreview({ input, preview: result.preview, confirmationToken: result.confirmationToken })
      return null
    } catch (error) {
      setPendingPreview(null)
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusy(false)
    }
  }, [pendingPreview, preview])

  const confirm = useCallback(async () => {
    const pending = pendingPreview
    if (pending === null) return null
    setBusy(true)
    setActionError(null)
    try {
      const result = await apply(pending.input, pending.confirmationToken)
      setPendingPreview(null)
      refetch()
      return result
    } catch (error) {
      setPendingPreview(null)
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusy(false)
    }
  }, [apply, pendingPreview, refetch])

  const cancel = useCallback(() => {
    setPendingPreview(null)
    setActionError(null)
  }, [])

  const clearError = useCallback(() => setActionError(null), [])
  return {
    ...request,
    busy,
    pendingPreview,
    actionError,
    mutate,
    confirm,
    cancel,
    clearError,
  }
}
