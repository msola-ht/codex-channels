import type { ComponentProps } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldGroup } from "@/components/ui/field"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { SettingsEmpty } from "@/components/settings/settings-feedback"
import { useTranslation } from "@/hooks/use-translation"
import type { ProviderSettingsController } from "@/lib/settings-management"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import type { Translate } from "@/lib/i18n/messages"

function searchLabel(t: Translate, mode: unknown): string {
  if (mode === null) return t("providerWebSearch.followGlobal")
  if (mode === "disabled") return t("settingsFields.off")
  if (mode === "cached") return t("settingsFields.cached")
  if (mode === "indexed") return t("settingsFields.indexed")
  if (mode === "live") return t("settingsFields.live")
  return t("common.unknown")
}

export function ProviderWebSearchSettings({ settings, management }: { settings: ManagementProviderSettingsResponse; management: ProviderSettingsController }) {
  const { t } = useTranslation()
  const locked = management.busy || management.loading || management.error !== null || management.readbackRequired || management.pendingPreview !== null
  const providers = [...settings.managedProviders, ...settings.customProviders.fixedCandidates, ...settings.customProviders.switchingProviders, ...settings.customProviders.backupCandidates]
  const searchSettings = settings.webSearchSettings.filter(setting => setting.source === "provider")
  return <Card>
    <CardHeader><CardTitle>{t("providerWebSearch.title")}</CardTitle><CardDescription>{t("providerWebSearch.hint")}</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-4">
      {searchSettings.length === 0 ? <SettingsEmpty>{t("providerWebSearch.empty")}</SettingsEmpty> : <FieldGroup>{searchSettings.map(setting => {
        const knownMode = setting.status === "ready" && (setting.mode === null || ["disabled", "cached", "indexed", "live"].includes(setting.mode))
        const label = setting.provider === "openai" ? "OpenAI" : providers.find(provider => provider.id === setting.provider)?.displayName ?? setting.provider
        const error = setting.status === "error" ? t(setting.error === "invalid-mode" ? "openAiModelCatalog.searchInvalidMode" : setting.error === "invalid-document" ? "openAiModelCatalog.searchInvalidDocument" : "openAiModelCatalog.searchReadFailed") : t("common.unknown")
        return <ManagedSelect key={setting.provider} label={t("providerWebSearch.providerLabel", { name: label, provider: setting.provider })}
          value={knownMode && setting.status === "ready" ? setting.mode ?? "global" : ""} placeholder={error}
          description={!knownMode ? error : undefined} disabled={locked || !knownMode}
          options={[["global", t("providerWebSearch.followGlobal")], ["disabled", t("settingsFields.off")], ["cached", t("settingsFields.cached")], ["indexed", t("settingsFields.indexed")], ["live", t("settingsFields.live")]]}
          onChange={value => {
            if (locked || setting.status !== "ready" || !knownMode) return
            const mode = value === "global" ? null : value === "disabled" || value === "cached" || value === "indexed" || value === "live" ? value : undefined
            if (mode === undefined || mode === setting.mode) return
            void management.mutate({ operation: "provider.web-search", provider: setting.provider, mode, resourceRevision: settings.resourceRevision })
          }} />
      })}</FieldGroup>}
      <p className="text-sm text-muted-foreground">{t("providerWebSearch.activationHint")}</p>
    </CardContent>
  </Card>
}

type SearchPreview = Extract<NonNullable<ProviderSettingsController["pendingPreview"]>["preview"], { operation: "provider.web-search" }>

export function ProviderWebSearchConfirmation({ preview, ...props }: {
  preview: SearchPreview
  saving: boolean
  loading?: boolean
  finalFocus?: ComponentProps<typeof ManagementConfirmationDialog>["finalFocus"]
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  return <ManagementConfirmationDialog {...props} open title={t("providerWebSearch.confirmTitle")} description={t("providerWebSearch.hint")}>
    <p>{t("managementUi.providerConfirm", { name: preview.provider })}</p>
    <p>{t("providerWebSearch.before", { mode: searchLabel(t, preview.before.mode) })}</p>
    <p>{t("providerWebSearch.after", { mode: searchLabel(t, preview.mode) })}</p>
    <p className="text-muted-foreground">{t("providerWebSearch.activationHint")}</p>
    {preview.activation === "restart-app-server" ? <p className="text-muted-foreground">{t("settingsUi.command", { value: "codexc restart appserver" })}</p> : null}
  </ManagementConfirmationDialog>
}
