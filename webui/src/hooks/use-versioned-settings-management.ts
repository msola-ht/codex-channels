import { useCallback, useRef, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { ApiClientError } from "@/lib/api"
import type { PendingSetting, SettingMutationPreview } from "@/lib/settings-management"

type VersionedSnapshot = object
type PreviewRequest<Setting> = (revision: string, setting: Setting) => Promise<SettingMutationPreview>
type UpdateRequest<Setting> = (revision: string, setting: Setting, confirmationToken?: string) => Promise<SettingMutationPreview>

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
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<{ setting: Setting; value: PendingSetting } | null>(null)
  const operationSequence = useRef(0)

  const previewSetting = useCallback(async (setting: Setting, label: string) => {
    const snapshot = data
    if (snapshot === null) return
    const operationId = ++operationSequence.current
    setSaving(true)
    setActionError(null)
    try {
      const result = await preview(revisionOf(snapshot), setting)
      if (operationId !== operationSequence.current) return
      setPending({
        setting,
        value: {
          kind: typeof setting === "object" && setting !== null && "kind" in setting ? String(setting.kind) : label,
          before: currentValue(snapshot, setting),
          value: result.value,
          label,
          target: result.activation.target,
          ...(result.confirmationToken === undefined ? {} : { confirmationToken: result.confirmationToken }),
        },
      })
    } catch (error) {
      if (operationId === operationSequence.current) {
        handleError(error, refetch, () => setPending(null), setActionError)
      }
    } finally {
      if (operationId === operationSequence.current) setSaving(false)
    }
  }, [currentValue, data, preview, refetch, revisionOf])

  const confirmSetting = useCallback(async () => {
    const snapshot = data
    const pendingSetting = pending
    if (snapshot === null || pendingSetting === null) return
    const operationId = ++operationSequence.current
    setSaving(true)
    setActionError(null)
    try {
      await update(revisionOf(snapshot), pendingSetting.setting, pendingSetting.value.confirmationToken)
      if (operationId !== operationSequence.current) return
      setPending(null)
      refetch()
    } catch (error) {
      if (operationId === operationSequence.current) {
        handleError(error, refetch, () => setPending(null), setActionError)
      }
    } finally {
      if (operationId === operationSequence.current) setSaving(false)
    }
  }, [data, pending, refetch, revisionOf, update])

  const cancelSetting = useCallback(() => {
    operationSequence.current += 1
    setPending(null)
    setActionError(null)
    setSaving(false)
  }, [])

  return {
    ...request,
    pendingSetting: pending?.value ?? null,
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
