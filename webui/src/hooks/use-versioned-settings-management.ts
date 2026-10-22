import { useCallback, useEffect, useRef, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { isUnconfirmedManagementWrite, useManagementReadback } from "@/hooks/use-management-readback"
import { ApiClientError } from "@/lib/api"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiError, translateSettingErrorCode } from "@/lib/i18n/translate"
import type { PendingSetting, SettingLabel, SettingMutationPreview } from "@/lib/settings-management"

type VersionedSnapshot = object
type SettingError = { code: string; kind?: string }
type PreviewRequest<Setting> = (revision: string, setting: Setting, signal?: AbortSignal) => Promise<SettingMutationPreview>
type UpdateRequest<Setting> = (revision: string, setting: Setting, confirmationToken?: string, signal?: AbortSignal) => Promise<SettingMutationPreview>

interface VersionedSettingsManagementOptions<Snapshot extends VersionedSnapshot, Setting> {
  load: (signal: AbortSignal) => Promise<Snapshot>
  preview: PreviewRequest<Setting>
  update: UpdateRequest<Setting>
  revisionOf: (snapshot: Snapshot) => string
  currentValue: (snapshot: Snapshot, setting: Setting) => unknown
  confirmationIntent?: (setting: Setting) => PendingSetting["intent"]
}

export function useVersionedSettingsManagement<Snapshot extends VersionedSnapshot, Setting>({
  load,
  preview,
  update,
  revisionOf,
  currentValue,
  confirmationIntent,
}: VersionedSettingsManagementOptions<Snapshot, Setting>) {
  const { t } = useTranslation()
  const request = useApi(load, [])
  const { data, refetch } = request
  const [lastAppliedSetting, setLastAppliedSetting] = useState<Setting | null>(null)
  const [actionError, setActionError] = useState<SettingError | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<{ setting: Setting; revision: string; value: PendingSetting } | null>(null)
  const [actionResult, setActionResult] = useState<SettingMutationPreview | null>(null)
  const { writeUnconfirmed, readbackRequired, requireReadback } = useManagementReadback(request)
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => { if (request.error !== null && operation.current === null) setPending(null) }, [request.error, saving])

  const previewSetting = useCallback(async (setting: Setting, label: SettingLabel) => {
    const snapshot = data
    if (snapshot === null || readbackRequired || request.loading || request.error !== null || saving || operation.current !== null || pending !== null) return
    const controller = new AbortController()
    operation.current = controller
    setSaving(true)
    setActionError(null)
    try {
      const result = await preview(revisionOf(snapshot), setting, controller.signal)
      if (controller.signal.aborted) return
      setPending({
        setting,
        revision: revisionOf(snapshot),
        value: {
          kind: typeof setting === "object" && setting !== null && "kind" in setting ? String(setting.kind) : typeof label === "string" ? label : label.key,
          before: currentValue(snapshot, setting),
          value: result.value,
          intent: confirmationIntent?.(setting),
          label,
          activation: result.activation,
          ...(result.confirmationToken === undefined ? {} : { confirmationToken: result.confirmationToken }),
        },
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        handleError(error, setting, refetch, () => setPending(null), setActionError)
      }
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }, [confirmationIntent, currentValue, data, preview, refetch, revisionOf, request.loading, request.error, saving, pending, readbackRequired])

  const confirmSetting = useCallback(async (): Promise<boolean> => {
    const snapshot = data
    const pendingSetting = pending
    if (snapshot === null || readbackRequired || pendingSetting === null || operation.current !== null || saving || request.loading || request.error !== null) return false
    const controller = new AbortController()
    operation.current = controller
    setSaving(true)
    setActionError(null)
    try {
      const result = await update(pendingSetting.revision, pendingSetting.setting, pendingSetting.value.confirmationToken, controller.signal)
      if (controller.signal.aborted) return false
      setPending(null)
      if (result.consistency !== "unknown") setLastAppliedSetting(pendingSetting.setting)
      setActionResult(result)
      requireReadback(snapshot, result.consistency === "unknown")
      refetch()
      return result.consistency !== "unknown"
    } catch (error) {
      if (!controller.signal.aborted) {
        setPending(null)
        handleError(error, pendingSetting.setting, refetch, () => setPending(null), setActionError)
        if (isUnconfirmedManagementWrite(error)) {
          const committed = error instanceof ApiClientError && error.code === "gateway_config_saved_cleanup_failed"
          if (committed) {
            setLastAppliedSetting(pendingSetting.setting)
            setActionResult(null)
          }
          requireReadback(snapshot, !committed)
          refetch()
        }
      }
      return false
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }, [data, pending, refetch, update, request.loading, request.error, saving, readbackRequired, requireReadback])

  const cancelSetting = useCallback(() => {
    if (operation.current !== null) return
    setPending(null)
    setActionError(null)
    setSaving(false)
  }, [])

  const refreshSettings = useCallback(() => {
    if (operation.current !== null) return
    refetch()
  }, [refetch])

  return {
    ...request,
    refetch: refreshSettings,
    error: translateApiError(t, request.error, request.errorCode),
    pendingSetting: pending?.value ?? null,
    lastAppliedSetting,
    actionResult,
    writeUnconfirmed,
    readbackRequired,
    actionError: actionError === null ? null : translateSettingErrorCode(t, actionError.code, actionError.kind),
    saving,
    previewSetting,
    confirmSetting,
    cancelSetting,
  }
}

function handleError(
  error: unknown,
  setting: unknown,
  refetch: () => void,
  clearPending: () => void,
  setError: (error: SettingError) => void,
) {
  const kind = typeof setting === "object" && setting !== null && "kind" in setting && typeof setting.kind === "string" ? setting.kind : undefined
  setError({ code: error instanceof ApiClientError ? error.code : "unknown", kind })
  if (error instanceof ApiClientError && error.code === "stale-revision") {
    clearPending()
    refetch()
  }
}
