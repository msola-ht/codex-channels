import { useCallback, useEffect, useRef, type ReactNode } from "react"
import { useApi } from "@/hooks/use-api"
import { useProviderSettingsManagement } from "@/hooks/use-provider-settings-management"
import { useAccountSettingsManagement } from "@/hooks/use-account-settings-management"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { useTranslation } from "@/hooks/use-translation"
import { fetchManagementProviders } from "@/lib/api"
import type { MessageKey } from "@/lib/i18n/messages"
import { ProviderSettingsManagement } from "@/components/settings/provider-settings-management"
import { AccountSettingsManagement } from "@/components/settings/account-settings-management"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { ProviderStatusCard } from "@/components/settings/provider-channel-status"
import { PendingSettingDialog, ManagedInputRow } from "@/components/settings/settings-controls"
import { SettingsError, LoadingSettingsCard } from "@/components/settings/settings-feedback"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { FieldGroup } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"

function ModelSettingsFrame({ title, busy, refresh, children }: { title: MessageKey; busy: boolean; refresh: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const pending = useRef(false)
  const lastRefresh = useRef(0)
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState !== "visible") return
      if (busy) { pending.current = true; return }
      pending.current = false
      if (Date.now() - lastRefresh.current < 5000) return
      lastRefresh.current = Date.now()
      refresh()
    }
    if (pending.current) visible()
    document.addEventListener("visibilitychange", visible)
    return () => document.removeEventListener("visibilitychange", visible)
  }, [busy, refresh])
  return <div className="flex min-w-0 flex-col gap-6">
    <div className="flex items-center justify-between gap-3"><h1 className="text-xl font-semibold">{t(title)}</h1><Button variant="outline" disabled={busy} onClick={refresh}>{t("relay.refresh")}</Button></div>
    {children}
  </div>
}

export function ProvidersPage() {
  const management = useProviderSettingsManagement()
  const status = useApi(fetchManagementProviders, [])
  const reload = management.refetch
  const reloadStatus = status.refetch
  const refresh = useCallback(() => { reload(); reloadStatus() }, [reload, reloadStatus])
  return <ModelSettingsFrame title="modelManagement.providers" busy={management.busy || management.loading || management.pendingPreview !== null || status.loading} refresh={refresh}>
    {status.error ? <SettingsError message={status.error} retry={reloadStatus} /> : status.data ? <ProviderStatusCard state={status.data} /> : <LoadingSettingsCard title="Provider" />}
    <ProviderSettingsManagement management={management} section="providers" onChanged={reloadStatus} />
  </ModelSettingsFrame>
}

export function ModelAccountsPage() {
  const management = useAccountSettingsManagement()
  return <ModelSettingsFrame title="modelManagement.accounts" busy={management.busy || management.loading || management.pendingPreview !== null} refresh={management.refetch}>
    <AccountSettingsManagement management={management} />
  </ModelSettingsFrame>
}

export function ModelConfigurationPage() {
  const { t } = useTranslation()
  const codex = useCodexSettingsManagement()
  const providers = useProviderSettingsManagement()
  const gateway = useSettingsManagement()
  const reloadCodex = codex.refetch, reloadProviders = providers.refetch, reloadGateway = gateway.refetch
  const refresh = useCallback(() => { reloadCodex(); reloadProviders(); reloadGateway() }, [reloadCodex, reloadProviders, reloadGateway])
  const busy = codex.loading || codex.saving || codex.pendingSetting !== null || providers.loading || providers.busy || providers.pendingPreview !== null || gateway.loading || gateway.saving || gateway.pendingSetting !== null
  return <ModelSettingsFrame title="modelManagement.models" busy={busy} refresh={refresh}>
    <AppServerSettingsCard management={codex} section="models" onChanged={reloadProviders} />
    <ProviderSettingsManagement management={providers} section="models" onChanged={reloadCodex} />
    <Card><CardHeader><CardTitle>{t("modelManagement.channelModel")}</CardTitle><CardDescription>{t("modelManagement.channelModelHint")}</CardDescription></CardHeader><CardContent>
      {gateway.loading && gateway.managedSettings === null && <Skeleton className="h-9 w-full" />}
      {gateway.error ? <SettingsError message={gateway.error} retry={reloadGateway} /> : gateway.managedSettings && <FieldGroup><ManagedInputRow label={t("modelManagement.channelModel")} defaultValue={gateway.managedSettings.system.defaultModel ?? ""} placeholder={t("modelManagement.followDefault")} disabled={busy} saved={gateway.lastAppliedSetting?.kind === "system.default-model" ? gateway.lastAppliedSetting : null} onBlur={value => void gateway.previewSetting("system.default-model", value || null, t("modelManagement.channelModel"))} /></FieldGroup>}
      {gateway.actionError && <Alert variant="destructive"><AlertDescription>{gateway.actionError}</AlertDescription></Alert>}
    </CardContent></Card>
    <PendingSettingDialog pending={gateway.pendingSetting} saving={gateway.saving} loading={gateway.loading} onCancel={gateway.cancelSetting} onConfirm={() => void gateway.confirmSetting()} />
  </ModelSettingsFrame>
}

export function ModelContextPage() {
  const codex = useCodexSettingsManagement()
  const providers = useProviderSettingsManagement()
  const reloadCodex = codex.refetch, reloadProviders = providers.refetch
  const refresh = useCallback(() => { reloadCodex(); reloadProviders() }, [reloadCodex, reloadProviders])
  return <ModelSettingsFrame title="modelManagement.context" busy={codex.loading || codex.saving || codex.pendingSetting !== null || providers.loading || providers.busy || providers.pendingPreview !== null} refresh={refresh}>
    <ProviderSettingsManagement management={providers} section="context" onChanged={reloadCodex} />
    <AppServerSettingsCard management={codex} section="context" onChanged={reloadProviders} />
  </ModelSettingsFrame>
}
