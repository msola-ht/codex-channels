import { useCallback, useEffect, useRef, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { ApiClientError } from "@/lib/api"
import type { PendingSetting, SettingMutationPreview } from "@/lib/settings-management"

type VersionedSnapshot = object
type PreviewRequest<Setting> = (revision: string, setting: Setting, signal?: AbortSignal) => Promise<SettingMutationPreview>
type UpdateRequest<Setting> = (revision: string, setting: Setting, confirmationToken?: string, signal?: AbortSignal) => Promise<SettingMutationPreview>

interface VersionedSettingsManagementOptions<Snapshot extends VersionedSnapshot, Setting> {
  load: (signal: AbortSignal) => Promise<Snapshot>
  preview: PreviewRequest<Setting>
  update: UpdateRequest<Setting>
  revisionOf: (snapshot: Snapshot) => string
  currentValue: (snapshot: Snapshot, setting: Setting) => unknown
}

export function useVersionedSettingsManagement<Snapshot extends VersionedSnapshot, Setting>({
  load,
  preview,
  update,
  revisionOf,
  currentValue,
}: VersionedSettingsManagementOptions<Snapshot, Setting>) {
  const request = useApi(load, [])
  const { data, refetch } = request
  const [lastAppliedSetting, setLastAppliedSetting] = useState<Setting | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<{ setting: Setting; revision: string; value: PendingSetting } | null>(null)
  const operation = useRef<AbortController | null>(null)
  useEffect(() => () => operation.current?.abort(), [])
  useEffect(() => { if (request.error !== null && operation.current === null) setPending(null) }, [request.error, saving])

  const previewSetting = useCallback(async (setting: Setting, label: string) => {
    const snapshot = data
    if (snapshot === null || request.loading || request.error !== null || saving || operation.current !== null || pending !== null) return
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
          kind: typeof setting === "object" && setting !== null && "kind" in setting ? String(setting.kind) : label,
          before: currentValue(snapshot, setting),
          value: result.value,
          label,
          activation: result.activation,
          ...(result.confirmationToken === undefined ? {} : { confirmationToken: result.confirmationToken }),
        },
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        handleError(error, refetch, () => setPending(null), setActionError)
      }
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }, [currentValue, data, preview, refetch, revisionOf, request.loading, request.error, saving, pending])

  const confirmSetting = useCallback(async (): Promise<boolean> => {
    const snapshot = data
    const pendingSetting = pending
    if (snapshot === null || pendingSetting === null || operation.current !== null || saving || request.loading || request.error !== null) return false
    const controller = new AbortController()
    operation.current = controller
    setSaving(true)
    setActionError(null)
    try {
      await update(pendingSetting.revision, pendingSetting.setting, pendingSetting.value.confirmationToken, controller.signal)
      if (controller.signal.aborted) return false
      setPending(null)
      setLastAppliedSetting(pendingSetting.setting)
      refetch()
      return true
    } catch (error) {
      if (!controller.signal.aborted) {
        setPending(null)
        handleError(error, refetch, () => setPending(null), setActionError)
      }
      return false
    } finally {
      if (operation.current === controller) operation.current = null
      if (!controller.signal.aborted) setSaving(false)
    }
  }, [data, pending, refetch, update, request.loading, request.error, saving])

  const cancelSetting = useCallback(() => {
    if (operation.current !== null) return
    setPending(null)
    setActionError(null)
    setSaving(false)
  }, [])

  return {
    ...request,
    pendingSetting: pending?.value ?? null,
    lastAppliedSetting,
    actionError,
    saving,
    previewSetting,
    confirmSetting,
    cancelSetting,
  }
}

function handleError(
  error: unknown,
  refetch: () => void,
  clearPending: () => void,
  setError: (message: string) => void,
) {
  setError(error instanceof Error ? error.message : String(error))
  if (error instanceof ApiClientError && error.code === "stale-revision") {
    clearPending()
    refetch()
  }
}
