import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { ApiClientError, fetchCodexUserSettings, previewCodexUserSetting, updateCodexUserSetting } from "@/lib/api"
import type { CodexUserSettingInput } from "@/lib/types"
import type { PendingSetting } from "@/hooks/use-settings-management"

export function useCodexSettingsManagement() {
  const request = useApi(fetchCodexUserSettings, [])
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingSetting, setPendingSetting] = useState<PendingSetting | null>(null)
  const [pendingInputState, setPendingInputState] = useState<CodexUserSettingInput | null>(null)

  const previewSetting = useCallback(async (setting: CodexUserSettingInput, label: string) => {
    const settings = request.data
    if (settings === null) return
    setSaving(true)
    setActionError(null)
    try {
      const preview = await previewCodexUserSetting(settings.version, setting)
      setPendingSetting({
        kind: setting.kind,
        before: currentValue(settings, setting),
        value: preview.value,
        label,
        target: preview.activation.target,
      })
      setPendingInputState(setting)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      if (error instanceof ApiClientError && error.code === "stale-revision") {
        setPendingSetting(null)
        setPendingInputState(null)
        request.refetch()
      }
    } finally {
      setSaving(false)
    }
  }, [request])

  const confirmSetting = useCallback(async () => {
    const settings = request.data
    const pending = pendingSetting
    const input = pendingInputState
    if (settings === null || pending === null || input === null) return
    setSaving(true)
    setActionError(null)
    try {
      await updateCodexUserSetting(settings.version, input)
      setPendingSetting(null)
      setPendingInputState(null)
      request.refetch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      if (error instanceof ApiClientError && error.code === "stale-revision") {
        setPendingSetting(null)
        setPendingInputState(null)
        request.refetch()
      }
    } finally {
      setSaving(false)
    }
  }, [pendingInputState, pendingSetting, request])

  const cancelSetting = useCallback(() => {
    setPendingSetting(null)
    setPendingInputState(null)
    setActionError(null)
  }, [])

  return { ...request, codexSettings: request.data, actionError, saving, pendingSetting, previewSetting, confirmSetting, cancelSetting }
}

function currentValue(settings: NonNullable<ReturnType<typeof fetchCodexUserSettings> extends Promise<infer T> ? T : never>, input: CodexUserSettingInput): unknown {
  if (input.kind === "defaults") return { model: settings.defaults.model, reasoningEffort: settings.defaults.reasoningEffort }
  if (input.kind === "fast") return settings.defaults.fastEnabled
  if (input.kind === "permissions") return settings.permissions
  if (input.kind === "web-search") return settings.defaults.webSearch
  if (input.kind === "update-plan") return settings.defaults.updatePlanEnabled
  if (input.kind === "preferences") return settings.defaults
  return null
}
