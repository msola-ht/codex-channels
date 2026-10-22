import { useCallback, useRef, useState } from "react"
import { Link } from "react-router"
import { useApi } from "@/hooks/use-api"
import { useProviderSettingsManagement } from "@/hooks/use-provider-settings-management"
import { useAccountSettingsManagement } from "@/hooks/use-account-settings-management"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { useOpenAiModelCatalog } from "@/hooks/use-openai-model-catalog"
import { useProviderModelCatalogs } from "@/hooks/use-provider-model-catalogs"
import { ModelDisplayGroups } from "@/components/settings/model-display-groups"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { fetchManagementProviders, fetchSettingsSummary } from "@/lib/api"
import { OpenAiModelCatalogCard } from "@/components/settings/openai-model-catalog-card"
import { ModelCatalogTable } from "@/components/settings/model-catalog-columns"
import { ProviderSettingsManagement } from "@/components/settings/provider-settings-management"
import { ProviderModelCatalogs } from "@/components/settings/provider-model-catalogs"
import { AccountSettingsManagement } from "@/components/settings/account-settings-management"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { ProviderStatusCard } from "@/components/settings/provider-channel-status"
import { PendingSettingDialog, ManagedInputRow, SettingsMutationFeedback, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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
  const [codexEditorOpen, setCodexEditorOpen] = useState(false)
  const [providerEditing, setProviderEditing] = useState(false)
  const [groupsEditing, setGroupsEditing] = useState(false)
  const codexEditorTrigger = useRef<HTMLButtonElement | null>(null)
  const catalog = useOpenAiModelCatalog()
  const reloadCatalog = catalog.refresh
  const codex = useCodexSettingsManagement()
  const providers = useProviderSettingsManagement()
  const localCatalogs = useProviderModelCatalogs(providers.settings)
  const gateway = useSettingsManagement()
  const reloadCodex = codex.refetch, reloadProviders = providers.refetch, reloadGateway = gateway.refetch
  const reloadLocalCatalogs = localCatalogs.refetch
  const refresh = useCallback(() => { reloadCodex(); reloadProviders(); reloadGateway(); reloadCatalog(); reloadLocalCatalogs() }, [reloadCodex, reloadProviders, reloadGateway, reloadCatalog, reloadLocalCatalogs])
  const busy = codex.loading || codex.saving || codex.pendingSetting !== null || providers.loading || providers.busy || providers.pendingPreview !== null || gateway.loading || gateway.saving || gateway.pendingSetting !== null
  const codexSettings = !codex.loading && codex.error === null && !codex.readbackRequired ? codex.codexSettings : null
  const defaultModel = codexSettings?.models.find(model => codexSettings.defaults.model === null ? model.isDefault : model.model === codexSettings.defaults.model)
  return <SettingsPageFrame title="modelManagement.models" busy={busy || catalog.pageBusy || localCatalogs.loading || codexEditorOpen || providerEditing || groupsEditing} refresh={refresh}>
    <OpenAiModelCatalogCard catalog={catalog} disabled={busy || providers.error !== null || codexEditorOpen} configurationRevision={providers.settings?.resourceRevision ?? null}
      defaultBadges={codexSettings && <>
        {codexSettings.provider !== "openai" && <Badge variant="outline">{t("settingsFields.currentProvider")}: {codexSettings.provider}</Badge>}
        <Badge variant="secondary">{t("settingsFields.defaultModel")}: {defaultModel?.displayName ?? codexSettings.defaults.model ?? t("customModel.unset")}</Badge>
        <Badge variant="secondary">{t("settingsFields.reasoningEffort")}: {codexSettings.defaults.reasoningEffort ?? t("customModel.unset")}</Badge>
      </>}
      editDefaultsAction={<Button ref={codexEditorTrigger} variant="outline" size="sm" disabled={busy || catalog.pageBusy || codexEditorOpen || codexSettings === null} onClick={() => setCodexEditorOpen(true)}>{t("modelManagement.actions")}</Button>}
      renderCatalog={official =>
      <ProviderModelCatalogs local={localCatalogs} management={providers} onChanged={reloadCodex} onEditingChange={setProviderEditing} renderCatalog={thirdParty =>
        <Card>
          <CardHeader><CardTitle>{t("modelCatalog.title")}</CardTitle><CardDescription>{t("modelCatalog.unifiedHint")} {t("openAiModelCatalog.searchReadOnlyHint")} <Link className="underline underline-offset-4" to="/settings">{t("openAiModelCatalog.editGlobalSearch")}</Link></CardDescription></CardHeader>
          <CardContent><ModelCatalogTable label={t("modelCatalog.title")} groups={[{ ...official, webSearchSettings: providers.settings?.webSearchSettings.filter(entry => entry.provider === "openai"), webSearchState: providers.loading ? "loading" : providers.error !== null ? "error" : undefined }, ...thirdParty]} /></CardContent>
        </Card>
      } />
    } />
    <AppServerSettingsCard management={codex} section="models" onChanged={reloadProviders} renderContent={content => <Dialog open={codexEditorOpen} onOpenChange={open => { if (!codex.saving && codex.pendingSetting === null) setCodexEditorOpen(open) }}>
      <DialogContent finalFocus={codexEditorTrigger} closeLabel={t("common.close")} showCloseButton={!codex.saving && codex.pendingSetting === null} className={modelOperationDialogClassName}>
        <DialogHeader><DialogTitle>{t("settingsFields.modelDefaults")}</DialogTitle><DialogDescription>{t("settingsFields.modelDefaultsHint")}</DialogDescription></DialogHeader>
        {content}
      </DialogContent>
    </Dialog>} />
    <ModelDisplayGroups management={gateway} onEditingChange={setGroupsEditing} providers={providers.settings} disabled={busy || gateway.error !== null || providers.error !== null || localCatalogs.loading || localCatalogs.error !== null || !localCatalogs.matchesManagement} />
    <Card><CardHeader><CardTitle>{t("modelManagement.channelModel")}</CardTitle><CardDescription>{t("modelManagement.channelModelHint")}</CardDescription></CardHeader><CardContent>
      {gateway.loading && gateway.managedSettings === null && <Skeleton className="h-9 w-full" />}
      {gateway.error ? <SettingsError message={gateway.error} retry={reloadGateway} /> : gateway.managedSettings && <FieldGroup><ManagedInputRow label={t("modelManagement.channelModel")} defaultValue={gateway.managedSettings.system.defaultModel ?? ""} placeholder={t("modelManagement.followDefault")} disabled={busy} saved={gateway.lastAppliedSetting?.kind === "system.default-model" ? gateway.lastAppliedSetting : null} onBlur={value => void gateway.previewSetting("system.default-model", value || null, { key: "modelManagement.channelModel" })} /></FieldGroup>}
      {gateway.actionError && <Alert variant="destructive"><AlertDescription>{gateway.actionError}</AlertDescription></Alert>}
    </CardContent></Card>
    <PendingSettingDialog pending={gateway.pendingSetting} saving={gateway.saving} loading={gateway.loading} onCancel={gateway.cancelSetting} onConfirm={() => void gateway.confirmSetting()} />
    <SettingsMutationFeedback result={gateway.actionResult} writeUnconfirmed={gateway.writeUnconfirmed} readbackRequired={gateway.readbackRequired} />
  </SettingsPageFrame>
}

export function ModelContextPage() {
  const codex = useCodexSettingsManagement()
  return <SettingsPageFrame title="modelManagement.context" busy={codex.loading || codex.saving || codex.pendingSetting !== null} refresh={codex.refetch}>
    <AppServerSettingsCard management={codex} section="context" />
  </SettingsPageFrame>
}
