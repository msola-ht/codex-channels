import { fetchManagementSettings, previewManagementSetting, updateManagementSetting } from "@/lib/api"
import { useVersionedSettingsManagement } from "@/hooks/use-versioned-settings-management"
import type { GatewaySettingsController } from "@/lib/settings-management"
import type { ManagementSettingInput, ManagementSettingsResponse } from "@/lib/types"

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

function currentValue(settings: ManagementSettingsResponse, setting: ManagementSettingInput): unknown {
  if (setting.kind === "display.operation-updates") return settings.display.operationUpdates
  if (setting.kind === "display.plan-updates") return settings.display.planUpdatesEnabled
  if (setting.kind === "display.reasoning") return settings.display.reasoningEnabled
  if (setting.kind === "system.sandbox") return settings.system.sandbox
  if (setting.kind === "system.approval-timeout") return settings.system.approvalTimeoutSeconds
  if (setting.kind === "system.idle-release-minutes") return settings.system.idleReleaseMinutes
  if (setting.kind === "automation.scheduled-tasks") return settings.automation.scheduledTasksEnabled
  if (setting.kind === "advanced.logging-level") return settings.advanced.loggingLevel
  if (setting.kind === "metrics.storage") return { storage: settings.metrics.storage }
  if (setting.kind === "webui.port" || setting.kind === "webui.host" || setting.kind === "webui.token") return settings.webui
  if (setting.kind === "advanced.plugin-api") return settings.advanced.pluginApiEnabled
  if (setting.kind === "system.default-model") return settings.system.defaultModel
  if (setting.kind === "system.default-workspace") return settings.system.defaultWorkspace
  if (setting.kind === "system.official-tui-identity") return settings.system.officialTuiIdentity
  if (setting.kind === "telegram.message-format") return settings.telegram.messageFormat
  if (setting.kind === "network.proxy" && setting.value !== null && typeof setting.value === "object") {
    const field = "field" in setting.value && typeof setting.value.field === "string" ? setting.value.field : ""
    return { field, configured: settings.network.configuredFields.includes(field) }
  }
  if (setting.kind === "network.proxy-batch") return settings.network.configuredFields
  if (setting.kind === "workspace.permissions" && setting.value !== null && typeof setting.value === "object") {
    const workspaceId = "workspaceId" in setting.value && typeof setting.value.workspaceId === "string"
      ? setting.value.workspaceId
      : ""
    return settings.system.workspaces.find((workspace) => workspace.id === workspaceId) ?? null
  }
  return null
}
