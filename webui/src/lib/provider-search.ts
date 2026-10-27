import type { Translate } from "@/lib/i18n/messages"
import type { ManagementProviderSettingsResponse } from "@/lib/types"

export type ProviderSearchSetting = ManagementProviderSettingsResponse["webSearchSettings"][number]
export type ProviderSearchMode = Extract<ProviderSearchSetting, { status: "ready" }>["mode"]

export function providerSearchModeLabel(t: Translate, mode: unknown, provider = ""): string {
  if (mode === null) return t(provider.startsWith("olc-") ? "providerWebSearch.defaultDisabled" : "providerWebSearch.followGlobal")
  if (mode === "disabled") return t("settingsFields.off")
  if (mode === "cached") return t("settingsFields.cached")
  if (mode === "indexed") return t("settingsFields.indexed")
  if (mode === "live") return t("settingsFields.live")
  return t("common.unknown")
}

export function providerSearchSettingLabel(t: Translate, setting: ProviderSearchSetting): string {
  if (setting.status === "error") return t(setting.error === "invalid-mode" ? "openAiModelCatalog.searchInvalidMode" : setting.error === "invalid-document" ? "openAiModelCatalog.searchInvalidDocument" : "openAiModelCatalog.searchReadFailed")
  return setting.source === "global" && setting.mode === null && !setting.provider.startsWith("olc-") ? t("providerWebSearch.globalDefault") : providerSearchModeLabel(t, setting.mode, setting.provider)
}
