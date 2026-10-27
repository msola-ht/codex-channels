import type { ComponentProps } from "react"
import { FieldGroup } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import { useTranslation } from "@/hooks/use-translation"
import type { ProviderSettingsController } from "@/lib/settings-management"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import { Link } from "react-router"
import { providerSearchModeLabel, providerSearchSettingLabel } from "@/lib/provider-search"

export function ProviderWebSearchSettings({ settings, management, provider }: { settings: ManagementProviderSettingsResponse; management: ProviderSettingsController; provider: string }) {
  const { t } = useTranslation()
  const locked = management.busy || management.loading || management.error !== null || management.readbackRequired || management.pendingPreview !== null
  const providers = [...settings.managedProviders, ...settings.customProviders.fixedCandidates, ...settings.customProviders.switchingProviders, ...settings.customProviders.backupCandidates]
  const searchSettings = settings.webSearchSettings.filter(setting => setting.source === "provider" && setting.provider === provider)
  return <div className="flex flex-col gap-4">
      {management.error && <SettingsError message={management.error} retry={management.refetch} />}
      {management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
      {management.readbackRequired && <Alert><AlertDescription className="flex flex-col gap-2"><p>{t(management.writeUnconfirmed ? "settingsUi.writeUnconfirmed" : "settingsUi.readbackUnknown")}</p><Button variant="outline" disabled={management.busy || management.loading} onClick={management.refetch}>{t("common.retry")}</Button></AlertDescription></Alert>}
      {searchSettings.length === 0 ? <SettingsEmpty>{t("providerWebSearch.empty")}</SettingsEmpty> : <FieldGroup>{searchSettings.map(setting => {
        const knownMode = setting.status === "ready" && (setting.mode === null || ["disabled", "cached", "indexed", "live"].includes(setting.mode))
        const label = setting.provider === "openai" ? "OpenAI" : providers.find(provider => provider.id === setting.provider)?.displayName ?? setting.provider
        const error = providerSearchSettingLabel(t, setting)
        return <ManagedSelect fullWidth key={setting.provider} label={t("providerWebSearch.providerLabel", { name: label, provider: setting.provider })}
          value={knownMode && setting.status === "ready" ? setting.mode ?? "global" : ""} placeholder={error}
          description={!knownMode ? error : setting.provider.startsWith("olc-") ? t("providerWebSearch.ollamaHint") : undefined} disabled={locked || !knownMode}
          options={[["global", providerSearchModeLabel(t, null, setting.provider)], ["disabled", t("settingsFields.off")], ["cached", t("settingsFields.cached")], ["indexed", t("settingsFields.indexed")], ["live", t("settingsFields.live")]]}
          onChange={value => {
            if (locked || setting.status !== "ready" || !knownMode) return
            const mode = value === "global" ? null : value === "disabled" || value === "cached" || value === "indexed" || value === "live" ? value : undefined
            if (mode === undefined || mode === setting.mode) return
            void management.mutate({ operation: "provider.web-search", provider: setting.provider, mode, resourceRevision: settings.resourceRevision })
          }} />
      })}</FieldGroup>}
      <p className="text-sm text-muted-foreground">{t("providerWebSearch.activationHint")}</p>
      <Button variant="outline" nativeButton={false} disabled={locked} render={<Link to="/settings/global?section=general" />}>{t("openAiModelCatalog.editGlobalSearch")}</Button>
    </div>
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
  return <ManagementConfirmationDialog {...props} open title={t("providerWebSearch.confirmTitle")} description={t(preview.provider.startsWith("olc-") ? "providerWebSearch.ollamaHint" : "providerWebSearch.hint")}>
    <p>{t("managementUi.providerConfirm", { name: preview.provider })}</p>
    <p>{t("providerWebSearch.before", { mode: providerSearchModeLabel(t, preview.before.mode, preview.provider) })}</p>
    <p>{t("providerWebSearch.after", { mode: providerSearchModeLabel(t, preview.mode, preview.provider) })}</p>
    <p className="text-muted-foreground">{t("providerWebSearch.activationHint")}</p>
    {preview.activation === "restart-app-server" ? <p className="text-muted-foreground">{t("settingsUi.command", { value: "codexc restart appserver" })}</p> : null}
  </ManagementConfirmationDialog>
}
