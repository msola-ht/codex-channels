import { fetchManagementSettings, previewManagementSetting, updateManagementSetting } from "@/lib/api"
import { useVersionedSettingsManagement } from "@/hooks/use-versioned-settings-management"
import type { GatewaySettingsController } from "@/lib/settings-management"
import type { ManagementSettingsResponse } from "@/lib/types"

export function useSettingsManagement(): GatewaySettingsController {
  const management = useVersionedSettingsManagement({
    load: fetchManagementSettings,
    preview: previewManagementSetting,
    update: updateManagementSetting,
    revisionOf: (settings) => settings.revision,
    currentValue,
  })
  return {
    loading: management.loading,
    error: management.error,
    actionError: management.actionError,
    saving: management.saving,
    pendingSetting: management.pendingSetting,
    previewSetting: (kind, value, label) => management.previewSetting({ kind, value }, label),
    confirmSetting: management.confirmSetting,
    cancelSetting: management.cancelSetting,
    refetch: management.refetch,
    managedSettings: management.data,
  }
}

function currentValue(settings: ManagementSettingsResponse, setting: { kind: string }): unknown {
  if (setting.kind === "display.operation-updates") return settings.display.operationUpdates
  if (setting.kind === "display.plan-updates") return settings.display.planUpdatesEnabled
  if (setting.kind === "display.reasoning") return settings.display.reasoningEnabled
  if (setting.kind === "display.price-currency") return settings.display.priceCurrency
  if (setting.kind === "system.sandbox") return settings.system.sandbox
  if (setting.kind === "system.approval-timeout") return settings.system.approvalTimeoutSeconds
  if (setting.kind === "automation.scheduled-tasks") return settings.automation.scheduledTasksEnabled
  if (setting.kind === "advanced.logging-level") return settings.advanced.loggingLevel
  if (setting.kind === "metrics.storage") return settings.metrics.storage
  if (setting.kind === "metrics.sync-params") return settings.metrics.sync
  if (setting.kind === "webui.port") return settings.webui.port
  if (setting.kind === "webui.host") return settings.webui.host
  if (setting.kind === "webui.token") return settings.webui.tokenConfigured ? "已配置" : "未配置"
  if (setting.kind === "advanced.plugin-api") return settings.advanced.pluginApiEnabled
  if (setting.kind === "system.default-model") return settings.system.defaultModel
  return null
}
