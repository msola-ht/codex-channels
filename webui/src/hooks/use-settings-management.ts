import { useCallback, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { ApiClientError, fetchManagementSettings, previewManagementSetting, updateManagementSetting } from "@/lib/api"

export type PendingSetting = { kind: string; before: unknown; value: unknown; label: string; target: string; confirmationToken?: string }

export function useSettingsManagement() {
  const request = useApi(fetchManagementSettings, [])
  const { data, refetch } = request
  const [actionError, setActionError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingSetting, setPendingSetting] = useState<PendingSetting | null>(null)

  const previewSetting = useCallback(async (kind: string, value: unknown, label: string) => {
    const settings = data
    if (settings === null) return
    setSaving(true)
    setActionError(null)
    try {
      const preview = await previewManagementSetting(settings.revision, { kind, value })
      setPendingSetting({ kind, before: currentManagedValue(settings, kind), value, label, target: preview.activation.target, ...(preview.confirmationToken === undefined ? {} : { confirmationToken: preview.confirmationToken }) })
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      if (error instanceof ApiClientError && error.code === "stale-revision") {
        setPendingSetting(null)
        refetch()
      }
    } finally {
      setSaving(false)
    }
  }, [data, refetch])

  const confirmSetting = useCallback(async () => {
    const settings = data
    const pending = pendingSetting
    if (settings === null || pending === null) return
    setSaving(true)
    setActionError(null)
    try {
      await updateManagementSetting(settings.revision, { kind: pending.kind, value: pending.value }, pending.confirmationToken)
      setPendingSetting(null)
      refetch()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
      if (error instanceof ApiClientError && error.code === "stale-revision") {
        setPendingSetting(null)
        refetch()
      }
    } finally {
      setSaving(false)
    }
  }, [data, pendingSetting, refetch])

  const cancelSetting = useCallback(() => {
    setPendingSetting(null)
    setActionError(null)
  }, [])

  return {
    ...request,
    managedSettings: data,
    actionError,
    saving,
    pendingSetting,
    previewSetting,
    confirmSetting,
    cancelSetting,
  }
}

function currentManagedValue(settings: Awaited<ReturnType<typeof fetchManagementSettings>>, kind: string): unknown {
  if (kind === "display.operation-updates") return settings.display.operationUpdates
  if (kind === "display.plan-updates") return settings.display.planUpdatesEnabled
  if (kind === "display.reasoning") return settings.display.reasoningEnabled
  if (kind === "display.price-currency") return settings.display.priceCurrency
  if (kind === "system.sandbox") return settings.system.sandbox
  if (kind === "system.approval-timeout") return settings.system.approvalTimeoutSeconds
  if (kind === "automation.scheduled-tasks") return settings.automation.scheduledTasksEnabled
  if (kind === "advanced.logging-level") return settings.advanced.loggingLevel
  if (kind === "metrics.storage") return settings.metrics.storage
  if (kind === "metrics.sync-params") return settings.metrics.sync
  if (kind === "webui.port") return settings.webui.port
  if (kind === "webui.host") return settings.webui.host
  if (kind === "webui.token") return settings.webui.tokenConfigured ? "已配置" : "未配置"
  if (kind === "advanced.plugin-api") return settings.advanced.pluginApiEnabled
  if (kind === "system.default-model") return settings.system.defaultModel
  return null
}
