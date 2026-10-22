import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { providerPlatform } from "@/lib/navigation"
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
import { ProviderDirectory } from "@/components/settings/provider-directory"
import { PendingSettingDialog, ManagedInputRow, SettingsMutationFeedback, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { SettingsError, SettingsEmpty } from "@/components/settings/settings-feedback"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { FieldGroup } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { SettingsPageFrame } from "@/components/settings/settings-page-frame"
import { SettingsCliCommands } from "@/components/settings/settings-cli-commands"
import { Skeleton } from "@/components/ui/skeleton"


export function ProvidersPage() {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [accountEditing, setAccountEditing] = useState(false)
  const [directoryEditing, setDirectoryEditing] = useState(false)
  const summary = useApi(fetchSettingsSummary, [])
  const reloadSummary = summary.refetch
  const management = useProviderSettingsManagement()
  const accounts = useAccountSettingsManagement()
  const reloadAccounts = accounts.refetch
  const status = useApi(fetchManagementProviders, [])
  const reload = management.refetch
  const reloadStatus = status.refetch
  const refresh = useCallback(() => { reload(); reloadAccounts(); reloadStatus(); reloadSummary() }, [reload, reloadAccounts, reloadStatus, reloadSummary])
  const afterProviderChange = useCallback(() => { reloadAccounts(); reloadStatus(); reloadSummary() }, [reloadAccounts, reloadStatus, reloadSummary])
  const afterAccountChange = useCallback(() => { reload(); reloadStatus(); reloadSummary() }, [reload, reloadStatus, reloadSummary])
  useEffect(() => { if (management.writeUnconfirmed && management.readbackRequired) afterProviderChange() }, [management.writeUnconfirmed, management.readbackRequired, afterProviderChange])
  useEffect(() => { if (accounts.writeUnconfirmed && accounts.readbackRequired) afterAccountChange() }, [accounts.writeUnconfirmed, accounts.readbackRequired, afterAccountChange])
  const busy = management.busy || management.loading || management.pendingPreview !== null || accounts.busy || accounts.loading || accounts.pendingPreview !== null
  return <SettingsPageFrame title="modelManagement.providers" busy={editing || accountEditing || directoryEditing || busy || status.loading || summary.loading} refresh={refresh}>
    {status.error && <SettingsError message={translateApiErrorCode(t, status.errorCode)} retry={reloadStatus} />}
    <ProviderSettingsManagement management={management} section="providers" onEditingChange={setEditing} onChanged={afterProviderChange} renderProviders={providerActions =>
      <AccountSettingsManagement management={accounts} onEditingChange={setAccountEditing} onChanged={afterAccountChange} renderAccounts={accountActions =>
        <ProviderDirectory providers={providerActions} accounts={accountActions} management={management} locked={busy || management.readbackRequired || accounts.readbackRequired}
          fresh={!management.loading && management.error === null && !management.readbackRequired}
          authenticated={!status.loading && !status.error ? status.data?.official.authenticated ?? null : null}
          onEditingChange={setDirectoryEditing} terminalContent={<SettingsCliCommands scope="providers" summary={summary} />} />
      } />
    } />
  </SettingsPageFrame>
}

export function ModelConfigurationPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedProvider = searchParams.get("provider")
  const sourcePlatform = providerPlatform(searchParams.get("platform"))
  const providerReturnSearch = sourcePlatform === "all" ? "" : `?${new URLSearchParams({ platform: searchParams.get("platform")! })}`
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
  const localOnly = providers.settings === null || providers.error !== null || !localCatalogs.matchesManagement
  const providerCatalogs = localOnly ? localCatalogs.data?.catalogs ?? [] : providers.settings?.modelCatalogs ?? []
  const selectedCatalogIds = new Set(providerCatalogs.filter(item => item.providers.includes(selectedProvider ?? "")).map(item => `provider:${item.provider}`))
  return <SettingsPageFrame title="modelManagement.models" busy={busy || catalog.pageBusy || localCatalogs.loading || codexEditorOpen || providerEditing || groupsEditing} refresh={refresh}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t("settingsFields.primaryDefaults")}</span>
        {codexSettings && <><Badge variant="outline">{t("settingsFields.currentProvider")}: {codexSettings.provider}</Badge>
        <Badge variant="secondary">{t("settingsFields.defaultModel")}: {defaultModel?.displayName ?? codexSettings.defaults.model ?? t("customModel.unset")}</Badge>
        <Badge variant="secondary">{t("settingsFields.reasoningEffort")}: {codexSettings.defaults.reasoningEffort ?? t("managementUi.followModelDefault")}</Badge>
        {!codexSettings.defaultsEditable && <span className="text-sm text-muted-foreground">{t("settingsFields.primaryDefaultsReadOnly")}</span>}</>}
      </div>
      <Button ref={codexEditorTrigger} variant="outline" size="sm" disabled={busy || catalog.pageBusy || codexEditorOpen || !codexSettings?.defaultsEditable} onClick={() => setCodexEditorOpen(true)}>{t("modelManagement.actions")}</Button>
    </div>
    <OpenAiModelCatalogCard catalog={catalog} disabled={busy || providers.error !== null || codexEditorOpen} configurationRevision={providers.settings?.resourceRevision ?? null}
      renderCatalog={official =>
      <ProviderModelCatalogs local={localCatalogs} management={providers} onChanged={reloadCodex} onEditingChange={setProviderEditing} renderCatalog={thirdParty =>
        <Card>
          <CardHeader><CardTitle>{t("modelCatalog.title")}</CardTitle><CardDescription>{t("modelCatalog.unifiedHint")} {t("openAiModelCatalog.searchReadOnlyHint")} <Link className="underline underline-offset-4" to="/settings">{t("openAiModelCatalog.editGlobalSearch")}</Link></CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2"><Button variant="outline" size="sm" nativeButton={false} render={<Link to={`/models/providers${providerReturnSearch}`} />}>{t("providerDirectory.backToProviders")}</Button>{selectedProvider && <div className="flex min-w-0 flex-wrap items-center gap-2"><Badge variant="outline">{selectedProvider}</Badge><Button variant="outline" size="sm" onClick={() => setSearchParams(previous => { const next = new URLSearchParams(previous); next.delete("provider"); return next })}>{t("providerDirectory.allModels")}</Button></div>}</div>
            {selectedProvider && selectedProvider !== "openai" && selectedCatalogIds.size === 0 && <SettingsEmpty>{t(providers.loading || localCatalogs.loading ? "common.loading" : localOnly && (localCatalogs.error !== null || localCatalogs.data === null) ? "modelCatalog.localUnavailable" : "providerDirectory.noCatalog")}</SettingsEmpty>}
            <ModelCatalogTable label={t("modelCatalog.title")} groups={[{ ...official, webSearchSettings: providers.settings?.webSearchSettings.filter(entry => entry.provider === "openai"), webSearchState: providers.loading ? "loading" as const : providers.error !== null ? "error" as const : undefined }, ...thirdParty].filter(group => !selectedProvider || group.id === "third-party-status" || (selectedProvider === "openai" ? group.id === "openai" : selectedCatalogIds.has(group.id)))} />
          </CardContent>
        </Card>
      } />
    } />
    <AppServerSettingsCard key={String(codexEditorOpen)} management={codex} section="models" onChanged={reloadProviders} renderContent={content => <Dialog open={codexEditorOpen} onOpenChange={open => { if (!codex.saving && codex.pendingSetting === null) setCodexEditorOpen(open) }}>
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
  const [editing, setEditing] = useState(false)
  return <SettingsPageFrame title="modelManagement.context" busy={editing || codex.loading || codex.saving || codex.pendingSetting !== null} refresh={codex.refetch}>
    <AppServerSettingsCard management={codex} section="context" onEditingChange={setEditing} />
  </SettingsPageFrame>
}
