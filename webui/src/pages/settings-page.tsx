import { useCallback } from "react"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useApi, type UseApiState } from "@/hooks/use-api"
import { useManagementTasks, useManagementTaskRefresh } from "@/hooks/use-management-tasks"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { fetchManagementProviders, fetchManagementServices, fetchUpstreamUserAgent, fetchSettingsSummary } from "@/lib/api"
import { SettingsPageFrame } from "@/components/settings/settings-page-frame"
import { GatewaySettingsSection } from "@/components/settings/gateway-settings-section"
import { SettingsCliCommands } from "@/components/settings/settings-cli-commands"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { GatewaySettingsCard } from "@/components/settings/gateway-settings-card"
import { WorkspaceSettingsCard } from "@/components/settings/workspace-settings-card"
import { WebuiDataSettingsCard } from "@/components/settings/webui-data-settings-card"
import { ManagedServices, RecentManagementTasks } from "@/components/settings/managed-services"
import { ManagementTaskControls } from "@/components/settings/management-task-controls"
import { SettingsError, LoadingSettingsCard } from "@/components/settings/settings-feedback"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import type { SettingsSummaryResponse } from "@/lib/types"
import type { GatewaySettingsController, CodexSettingsController, ManagementTaskController } from "@/lib/settings-management"

function gatewayBusy(state: GatewaySettingsController) { return state.loading || state.saving || state.pendingSetting !== null }
function codexBusy(state: CodexSettingsController) { return state.loading || state.saving || state.pendingSetting !== null }
function tasksBusy(state: ManagementTaskController) { return state.loading || state.saving || state.pendingPreview !== null }

export function SettingsPage({ section = "general" }: { section?: "general" | "permissions" }) {
  return section === "general" ? <GeneralSettingsPage /> : <PreferenceSettingsPage section="permissions" />
}

function GeneralSettingsPage() {
  const summary = useApi(fetchSettingsSummary, [])
  return <PreferenceSettingsPage section="general" summary={summary} />
}

function PreferenceSettingsPage({ section, summary }: { section: "general" | "permissions"; summary?: UseApiState<SettingsSummaryResponse> & { refetch: () => void } }) {
  const gateway = useSettingsManagement()
  const codex = useCodexSettingsManagement()
  const reloadGateway = gateway.refetch, reloadCodex = codex.refetch
  const reloadSummary = summary?.refetch
  const refresh = useCallback(() => { reloadGateway(); reloadCodex(); reloadSummary?.() }, [reloadGateway, reloadCodex, reloadSummary])
  return <SettingsPageFrame title={section === "general" ? "navigation.general" : "navigation.permissions"} busy={gatewayBusy(gateway) || codexBusy(codex) || (summary?.loading ?? false)} refresh={refresh}>
    <AppServerSettingsCard management={codex} section={section} onChanged={reloadGateway} />
    <GatewaySettingsSection management={gateway} onChanged={reloadCodex}>
      <GatewaySettingsCard management={gateway} section={section} />
      {section === "permissions" && <WorkspaceSettingsCard management={gateway} />}
    </GatewaySettingsSection>
    {section === "general" && summary && <SettingsCliCommands scope="general" summary={summary} />}
  </SettingsPageFrame>
}

export function NetworkSettingsPage() {
  const gateway = useSettingsManagement()
  const upstream = useApi(fetchUpstreamUserAgent, [])
  const reloadGateway = gateway.refetch, reloadUpstream = upstream.refetch
  const refresh = useCallback(() => { reloadGateway(); reloadUpstream() }, [reloadGateway, reloadUpstream])
  return <SettingsPageFrame title="navigation.network" busy={gatewayBusy(gateway) || upstream.loading} refresh={refresh}>
    <GatewaySettingsSection management={gateway} onChanged={reloadUpstream}>
      <WebuiDataSettingsCard management={gateway} section="network" />
      <GatewaySettingsCard management={gateway} section="network" upstreamAgent={upstream} />
    </GatewaySettingsSection>
  </SettingsPageFrame>
}

export function DataSettingsPage() {
  const { t } = useTranslation()
  const summary = useApi(fetchSettingsSummary, [])
  const reloadSummary = summary.refetch
  const gateway = useSettingsManagement()
  const providers = useApi(fetchManagementProviders, [])
  const tasks = useManagementTasks()
  const reloadGateway = gateway.refetch, reloadProviders = providers.refetch, reloadTasks = tasks.refetch
  const refreshSettings = useCallback(() => { reloadGateway(); reloadProviders() }, [reloadGateway, reloadProviders])
  const refresh = useCallback(() => { refreshSettings(); reloadTasks(); reloadSummary() }, [refreshSettings, reloadTasks, reloadSummary])
  useManagementTaskRefresh(tasks, refreshSettings)
  return <SettingsPageFrame title="navigation.data" busy={gatewayBusy(gateway) || providers.loading || tasksBusy(tasks) || summary.loading} refresh={refresh}>
    <GatewaySettingsSection management={gateway}>
      <GatewaySettingsCard management={gateway} section="data" />
      <WebuiDataSettingsCard management={gateway} section="data" />
    </GatewaySettingsSection>
    {providers.error && <SettingsError message={translateApiErrorCode(t, providers.errorCode)} retry={reloadProviders} />}
    <TaskErrors tasks={tasks} />
    <ManagementTaskControls tasks={tasks} section="data" providerIds={[...(providers.data?.primary.id ? [providers.data.primary.id] : []), ...(providers.data?.providers.map(provider => provider.id) ?? [])]} />
    {tasks.tasks.length > 0 && <RecentManagementTasks tasks={tasks} />}
    <SettingsCliCommands scope="data" summary={summary} />
  </SettingsPageFrame>
}

export function ServiceSettingsPage() {
  const summary = useApi(fetchSettingsSummary, [])
  const reloadSummary = summary.refetch
  const { t } = useTranslation()
  const services = useApi(fetchManagementServices, [])
  const tasks = useManagementTasks()
  const reloadServices = services.refetch, reloadTasks = tasks.refetch
  const refresh = useCallback(() => { reloadServices(); reloadTasks(); reloadSummary() }, [reloadServices, reloadTasks, reloadSummary])
  useManagementTaskRefresh(tasks, reloadServices)
  return <SettingsPageFrame title="navigation.services" busy={services.loading || tasksBusy(tasks) || summary.loading} refresh={refresh}>
    <TaskErrors tasks={tasks} />
    {services.error ? <SettingsError message={translateApiErrorCode(t, services.errorCode)} retry={reloadServices} /> : !services.data ? <LoadingSettingsCard title={t("navigation.services")} /> : <Card>
      <CardHeader><CardTitle>{t("navigation.services")}</CardTitle><CardDescription>{t("navigation.servicesHint")}</CardDescription></CardHeader>
      <CardContent><ManagedServices services={{ ...services.data, entries: services.data.entries.filter(service => service.target !== "model-relay") }} tasks={tasks} showTasks={false} /></CardContent>
    </Card>}
    <ManagementTaskControls tasks={tasks} section="services" />
    {tasks.tasks.length > 0 && <RecentManagementTasks tasks={tasks} />}
    <SettingsCliCommands scope="services" summary={summary} />
  </SettingsPageFrame>
}

function TaskErrors({ tasks }: { tasks: ManagementTaskController }) {
  const error = tasks.error ?? tasks.notificationError
  return <>{error && <SettingsError message={error} retry={tasks.refetch} />}{tasks.actionError && <Alert variant="destructive"><AlertDescription>{tasks.actionError}</AlertDescription></Alert>}</>
}
