import { fetchManagementSettings, previewManagementSetting, updateManagementSetting } from "@/lib/api"
import { useVersionedSettingsManagement } from "@/hooks/use-versioned-settings-management"
import type { GatewaySettingsController, PendingSetting } from "@/lib/settings-management"
import type { ManagementSettingInput, ManagementSettingsResponse } from "@/lib/types"

export function useSettingsManagement(): GatewaySettingsController {
  const management = useVersionedSettingsManagement({
    load: fetchManagementSettings,
    preview: previewManagementSetting,
    update: updateManagementSetting,
    revisionOf: (settings) => settings.revision,
    currentValue,
    confirmationIntent,
  })
  return {
    actionResult: management.actionResult,
    writeUnconfirmed: management.writeUnconfirmed,
    readbackRequired: management.readbackRequired,
    lastAppliedSetting: management.lastAppliedSetting,
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

/** Confirmation copy retains only the supported action, never the input secret. */
function confirmationIntent(setting: ManagementSettingInput): PendingSetting["intent"] {
  if (setting.kind !== "webui.token" && setting.kind !== "network.proxy") return undefined
  const value = setting.value
  if (value === null || typeof value !== "object" || !("action" in value)) return undefined
  if (value.action === "set" || value.action === "clear") return value.action
  if (setting.kind === "webui.token" && value.action === "generate") return "generate"
  return undefined
}

function currentValue(settings: ManagementSettingsResponse, setting: ManagementSettingInput): unknown {
  if (setting.kind === "display.scope" && setting.value !== null && typeof setting.value === "object" && "selector" in setting.value) {
    const selector = setting.value.selector
    return settings.display.scopes.find(scope => JSON.stringify(scope.selector) === JSON.stringify(selector)) ?? null
  }
  if (setting.kind === "display.model-aliases") return settings.display.modelAliases
  if (setting.kind === "display.operation-updates") return settings.display.operationUpdates
  if (setting.kind === "display.plan-updates") return settings.display.planUpdatesEnabled
  if (setting.kind === "display.reasoning") return settings.display.reasoningEnabled
  if (setting.kind === "display.completion") return { completion: settings.display.completion, completionOverride: settings.display.completionOverride }
  if (setting.kind === "display.presentation-detail") return { presentationDetail: settings.display.presentationDetail, presentationDetailOverride: settings.display.presentationDetailOverride }
  if (setting.kind === "display.subagents") return { subagentsEnabled: settings.display.subagentsEnabled, subagentsOverride: settings.display.subagentsOverride }
  if (setting.kind === "display.streaming") return { streamingEnabled: settings.display.streamingEnabled, streamingOverride: settings.display.streamingOverride }
  if (setting.kind === "system.approval-timeout") return settings.system.approvalTimeoutSeconds
  if (setting.kind === "system.idle-release-minutes") return settings.system.idleReleaseMinutes
  if (setting.kind === "system.model-traffic-mode") return {
    modelTrafficMode: settings.system.modelTrafficMode,
    modelTrafficInputItems: settings.system.modelTrafficInputItems,
    modelTrafficItemMaxBytes: settings.system.modelTrafficItemMaxBytes,
  }
  if (setting.kind === "system.model-traffic-dump") return settings.system.modelTrafficDumpEnabled
  if (setting.kind === "system.model-traffic-retention-days") return settings.system.modelTrafficRetentionDays
  if (setting.kind === "automation.scheduled-tasks") return settings.automation.scheduledTasksEnabled
  if (setting.kind === "advanced.logging-level") return settings.advanced.loggingLevel
  if (setting.kind === "metrics.storage") return { storage: settings.metrics.storage }
  if (setting.kind === "webui.port" || setting.kind === "webui.host" || setting.kind === "webui.token") return settings.webui
  if (setting.kind === "system.default-model") return settings.system.defaultModel
  if (setting.kind === "system.default-workspace") return settings.system.defaultWorkspace
  if (setting.kind === "system.official-tui-identity") return settings.system.officialTuiIdentity
  if (setting.kind === "telegram.message-format") return settings.telegram.messageFormat
  if (setting.kind === "network.proxy" && setting.value !== null && typeof setting.value === "object") {
    const field = "field" in setting.value && typeof setting.value.field === "string" ? setting.value.field : ""
    return { field, configured: settings.network.configuredFields.includes(field) }
  }
  if (setting.kind === "network.proxy-batch") return settings.network.configuredFields
  return null
}
