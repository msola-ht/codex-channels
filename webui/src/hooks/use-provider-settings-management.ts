import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"
import {
  applyManagementProviderSettings,
  fetchManagementProviderSettings,
  previewManagementProviderSettings,
} from "@/lib/api"
import type {
  ManagementProviderSettingsMutationInput,
  ManagementProviderSettingsPreview,
} from "@/lib/types"
import type { ProviderSettingsController } from "@/lib/settings-management"

export function useProviderSettingsManagement(): ProviderSettingsController {
  const request = useApi(fetchManagementProviderSettings, [])
  const { data, loading, error, refetch } = request
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingPreview, setPendingPreview] = useState<{
    input: ManagementProviderSettingsMutationInput
    preview: ManagementProviderSettingsPreview
    confirmationToken: string
  } | null>(null)

  const mutate = useCallback(async (input: ManagementProviderSettingsMutationInput) => {
    if (pendingPreview !== null) return null
    setBusy(true)
    setActionError(null)
    try {
      const preview = await previewManagementProviderSettings(input)
      setPendingPreview({ input, preview: preview.preview, confirmationToken: preview.confirmationToken })
      return null
    } catch (error) {
      setPendingPreview(null)
      setActionError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setBusy(false)
    }
  }, [pendingPreview])

  const confirm = useCallback(async () => {
    const pending = pendingPreview
    if (pending === null) return null
    setBusy(true)
    setActionError(null)
    try {
      const result = await applyManagementProviderSettings(pending.input, pending.confirmationToken)
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
  }, [pendingPreview, refetch])

  const cancel = useCallback(() => {
    setPendingPreview(null)
    setActionError(null)
  }, [])

  const clearError = useCallback(() => setActionError(null), [])
  return {
    settings: data,
    loading,
    error,
    actionError,
    busy,
    pendingPreview,
    refetch,
    mutate,
    confirm,
    cancel,
    clearError,
  }
}
