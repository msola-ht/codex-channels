import { fetchCodexUserSettings, previewCodexUserSetting, updateCodexUserSetting } from "@/lib/api"
import { useVersionedSettingsManagement } from "@/hooks/use-versioned-settings-management"
import type { CodexSettingsController } from "@/lib/settings-management"
import type { CodexUserSettingInput, CodexUserSettingsResponse } from "@/lib/types"

export function useCodexSettingsManagement(): CodexSettingsController {
  const management = useVersionedSettingsManagement({
    load: fetchCodexUserSettings,
    preview: previewCodexUserSetting,
    update: updateCodexUserSetting,
    revisionOf: (settings) => settings.version,
    currentValue,
  })
  return {
    ...management,
    codexSettings: management.data,
  }
}

function currentValue(settings: CodexUserSettingsResponse, setting: CodexUserSettingInput): unknown {
  if (setting.kind === "tool-access") return {
    path: setting.path,
    value: settings.toolSettings.fields.find((field) => JSON.stringify(field.path) === JSON.stringify(setting.path))?.userValue ?? null,
  }
  if (setting.kind === "defaults") return { model: settings.defaults.model, reasoningEffort: settings.defaults.reasoningEffort }
  if (setting.kind === "service-tier") return { serviceTier: settings.defaults.serviceTier }
  if (setting.kind === "approvals-reviewer") return { value: settings.approvalsReviewer.value }
  if (setting.kind === "permissions") return Object.fromEntries(
    (["sandboxMode", "approvalPolicy", "networkAccess"] as const)
      .filter(field => Object.hasOwn(setting, field))
      .map(field => [field, settings.permissions.unsupportedFields.includes(field) ? "unsupported" : settings.permissions[field]]),
  )
  if (setting.kind === "web-search") return { mode: settings.defaults.webSearch }
  if (setting.kind === "update-plan") return { enabled: settings.defaults.updatePlanEnabled }
  if (setting.kind === "auto-recap") return { enabled: settings.defaults.autoRecapEnabled }
  if (setting.kind === "model-compact") return settings.compact
  if (setting.kind === "preferences") return {
    planModeReasoningEffort: settings.defaults.planModeReasoningEffort,
    reasoningSummary: settings.defaults.reasoningSummary,
    verbosity: settings.defaults.verbosity,
    checkForUpdateOnStartup: settings.defaults.checkForUpdateOnStartup,
    historyPersistence: settings.defaults.historyPersistence,
  }
  return null
}
