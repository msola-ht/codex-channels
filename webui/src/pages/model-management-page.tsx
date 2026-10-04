import { useCallback } from "react"
import { useApi } from "@/hooks/use-api"
import { useProviderSettingsManagement } from "@/hooks/use-provider-settings-management"
import { useAccountSettingsManagement } from "@/hooks/use-account-settings-management"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { fetchManagementProviders, fetchSettingsSummary } from "@/lib/api"
import { ProviderSettingsManagement } from "@/components/settings/provider-settings-management"
import { AccountSettingsManagement } from "@/components/settings/account-settings-management"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { ProviderStatusCard } from "@/components/settings/provider-channel-status"
import { PendingSettingDialog, ManagedInputRow } from "@/components/settings/settings-controls"
import { SettingsError, LoadingSettingsCard } from "@/components/settings/settings-feedback"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { FieldGroup } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SettingsPageFrame } from "@/components/settings/settings-page-frame"
import { SettingsCliCommands } from "@/components/settings/settings-cli-commands"
import { Skeleton } from "@/components/ui/skeleton"


export function ProvidersPage() {
  const { t } = useTranslation()
  const summary = useApi(fetchSettingsSummary, [])
  const reloadSummary = summary.refetch
  const management = useProviderSettingsManagement()
  const status = useApi(fetchManagementProviders, [])
  const reload = management.refetch
  const reloadStatus = status.refetch
  const refresh = useCallback(() => { reload(); reloadStatus(); reloadSummary() }, [reload, reloadStatus, reloadSummary])
  return <SettingsPageFrame title="modelManagement.providers" busy={management.busy || management.loading || management.pendingPreview !== null || status.loading || summary.loading} refresh={refresh}>
    {status.error ? <SettingsError message={translateApiErrorCode(t, status.errorCode)} retry={reloadStatus} /> : status.data ? <ProviderStatusCard state={status.data} /> : <LoadingSettingsCard title={t("modelManagement.providers")} />}
    <ProviderSettingsManagement management={management} section="providers" onChanged={reloadStatus} />
    <SettingsCliCommands scope="providers" summary={summary} />
  </SettingsPageFrame>
}

export function ModelAccountsPage() {
  const management = useAccountSettingsManagement()
  return <SettingsPageFrame title="modelManagement.accounts" busy={management.busy || management.loading || management.pendingPreview !== null} refresh={management.refetch}>
    <AccountSettingsManagement management={management} />
  </SettingsPageFrame>
}

export function ModelConfigurationPage() {
  const { t } = useTranslation()
  const codex = useCodexSettingsManagement()
  const providers = useProviderSettingsManagement()
  const gateway = useSettingsManagement()
  const reloadCodex = codex.refetch, reloadProviders = providers.refetch, reloadGateway = gateway.refetch
  const refresh = useCallback(() => { reloadCodex(); reloadProviders(); reloadGateway() }, [reloadCodex, reloadProviders, reloadGateway])
  const busy = codex.loading || codex.saving || codex.pendingSetting !== null || providers.loading || providers.busy || providers.pendingPreview !== null || gateway.loading || gateway.saving || gateway.pendingSetting !== null
  return <SettingsPageFrame title="modelManagement.models" busy={busy} refresh={refresh}>
    <AppServerSettingsCard management={codex} section="models" onChanged={reloadProviders} />
    <ProviderSettingsManagement management={providers} section="models" onChanged={reloadCodex} />
    <Card><CardHeader><CardTitle>{t("modelManagement.channelModel")}</CardTitle><CardDescription>{t("modelManagement.channelModelHint")}</CardDescription></CardHeader><CardContent>
      {gateway.loading && gateway.managedSettings === null && <Skeleton className="h-9 w-full" />}
      {gateway.error ? <SettingsError message={gateway.error} retry={reloadGateway} /> : gateway.managedSettings && <FieldGroup><ManagedInputRow label={t("modelManagement.channelModel")} defaultValue={gateway.managedSettings.system.defaultModel ?? ""} placeholder={t("modelManagement.followDefault")} disabled={busy} saved={gateway.lastAppliedSetting?.kind === "system.default-model" ? gateway.lastAppliedSetting : null} onBlur={value => void gateway.previewSetting("system.default-model", value || null, { key: "modelManagement.channelModel" })} /></FieldGroup>}
      {gateway.actionError && <Alert variant="destructive"><AlertDescription>{gateway.actionError}</AlertDescription></Alert>}
    </CardContent></Card>
    <PendingSettingDialog pending={gateway.pendingSetting} saving={gateway.saving} loading={gateway.loading} onCancel={gateway.cancelSetting} onConfirm={() => void gateway.confirmSetting()} />
  </SettingsPageFrame>
}

export function ModelContextPage() {
  const codex = useCodexSettingsManagement()
  const providers = useProviderSettingsManagement()
  const reloadCodex = codex.refetch, reloadProviders = providers.refetch
  const refresh = useCallback(() => { reloadCodex(); reloadProviders() }, [reloadCodex, reloadProviders])
  return <SettingsPageFrame title="modelManagement.context" busy={codex.loading || codex.saving || codex.pendingSetting !== null || providers.loading || providers.busy || providers.pendingPreview !== null} refresh={refresh}>
    <ProviderSettingsManagement management={providers} section="context" onChanged={reloadCodex} />
    <AppServerSettingsCard management={codex} section="context" onChanged={reloadProviders} />
  </SettingsPageFrame>
}
