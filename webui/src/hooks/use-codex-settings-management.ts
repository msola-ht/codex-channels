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
  if (setting.kind === "permissions") return settings.permissions
  if (setting.kind === "web-search") return settings.defaults.webSearch
  if (setting.kind === "update-plan") return settings.defaults.updatePlanEnabled
  if (setting.kind === "preferences") return settings.defaults
  return null
}
