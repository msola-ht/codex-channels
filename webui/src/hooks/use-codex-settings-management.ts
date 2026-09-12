import { fetchCodexUserSettings, previewCodexUserSetting, updateCodexUserSetting } from "@/lib/api"
import { useVersionedSettingsManagement } from "@/hooks/use-versioned-settings-management"
import type { CodexSettingsController } from "@/lib/settings-management"
import type { CodexUserSettingInput, CodexUserSettingsResponse } from "@/lib/types"

export function useCodexSettingsManagement(): CodexSettingsController {
  const management = useVersionedSettingsManagement({
    load: fetchCodexUserSettings,
    preview: previewCodexUserSetting,
    update: (revision, setting) => updateCodexUserSetting(revision, setting),
    revisionOf: (settings) => settings.version,
    currentValue,
  })
  return {
    ...management,
    codexSettings: management.data,
  }
}

function currentValue(settings: CodexUserSettingsResponse, setting: CodexUserSettingInput): unknown {
  if (setting.kind === "defaults") return { model: settings.defaults.model, reasoningEffort: settings.defaults.reasoningEffort }
  if (setting.kind === "fast") return settings.defaults.fastEnabled
  if (setting.kind === "permissions") return {
    sandboxMode: settings.permissions.sandboxMode ?? "read-only",
    approvalPolicy: settings.permissions.approvalPolicy ?? "on-request",
    networkAccess: settings.permissions.networkAccess ?? false,
  }
  if (setting.kind === "web-search") return settings.defaults.webSearch
  if (setting.kind === "update-plan") return settings.defaults.updatePlanEnabled
  if (setting.kind === "context-management") return settings.defaults.contextManagementEnabled
  if (setting.kind === "auto-recap") return settings.defaults.autoRecapEnabled
  if (setting.kind === "model-compact") return settings.compact
  if (setting.kind === "preferences") return {
    planModeReasoningEffort: settings.defaults.planModeReasoningEffort,
    reasoningSummary: settings.defaults.reasoningSummary,
    verbosity: settings.defaults.verbosity,
    personality: settings.defaults.personality,
    checkForUpdateOnStartup: settings.defaults.checkForUpdateOnStartup,
    historyPersistence: settings.defaults.historyPersistence,
  }
  return null
}
