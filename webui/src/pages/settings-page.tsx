import { Fragment, useEffect, useState } from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ApiProviderManagement } from "@/components/settings/api-provider-management"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { ChannelStatusCard, ProviderStatusCard } from "@/components/settings/provider-channel-status"
import { CliCommandRow } from "@/components/settings/cli-command-row"
import { GatewaySettingsCard } from "@/components/settings/gateway-settings-card"
import { ManagementTaskControls } from "@/components/settings/management-task-controls"
import { ManagedServices } from "@/components/settings/managed-services"
import { PendingSettingCard } from "@/components/settings/settings-controls"
import { WebuiDataSettingsCard } from "@/components/settings/webui-data-settings-card"
import { SettingsError, SettingsSkeleton, LoadingSettingsCard } from "@/components/settings/settings-feedback"
import { useCurrency } from "@/hooks/currency-context"
import type { UseApiState } from "@/hooks/use-api"
import { useApi } from "@/hooks/use-api"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useManagementTasks } from "@/hooks/use-management-tasks"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { fetchManagementProviders, fetchManagementServices, fetchSettingsSummary } from "@/lib/api"
import { resolveSettingsLoadState } from "@/lib/settings-state"
import type { DisplayCurrency } from "@/lib/format"
import type { ManagementProvidersResponse, ManagementServicesResponse, SettingsResponse, SettingsSummaryResponse } from "@/lib/types"
import type { CodexSettingsController, GatewaySettingsController, ManagementTaskController } from "@/lib/settings-management"

export function SettingsPage() {
  const { currency, settings } = useCurrency()
  const summary = useApi(fetchSettingsSummary, [])
  const services = useApi(fetchManagementServices, [])
  const providers = useApi(fetchManagementProviders, [])
  const management = useSettingsManagement()
  const codexManagement = useCodexSettingsManagement()
  const tasks = useManagementTasks()
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)

  useEffect(() => {
    if (!tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))) return undefined
    const timer = window.setInterval(services.refetch, 2_000)
    return () => window.clearInterval(timer)
  }, [services.refetch, tasks.tasks])

  const copyCommand = async (id: string, command: string) => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard_unavailable")
      await navigator.clipboard.writeText(command)
      setCopiedCommand(id)
      setCopyError(false)
    } catch {
      setCopiedCommand(null)
      setCopyError(true)
    }
  }

  const loadState = resolveSettingsLoadState(summary.data, summary.loading, summary.error)
  return <div className="flex flex-col gap-6">
    <div>
      <h1 className="text-xl font-semibold">设置</h1>
      <p className="text-sm text-muted-foreground">按 App Server、Gateway 和 WebUI 边界查看并修改配置。</p>
    </div>
    {loadState === "loading" ? <SettingsSkeleton /> : null}
    {loadState === "error" ? <SettingsError message={summary.error ?? "设置快照加载失败"} retry={summary.refetch} /> : null}
    {loadState === "empty" ? <SettingsError message="服务未返回可用的设置快照" retry={summary.refetch} /> : null}
    {loadState === "ready" && summary.data !== null ? <SettingsContent
      currency={currency}
      settings={settings}
      summary={summary.data}
      services={services}
      providers={providers}
      management={management}
      codexManagement={codexManagement}
      tasks={tasks}
      copiedCommand={copiedCommand}
      copyError={copyError}
      onCopy={copyCommand}
    /> : null}
  </div>
}

interface SettingsContentProps {
  currency: DisplayCurrency | null
  settings: SettingsResponse | null
  summary: SettingsSummaryResponse
  services: UseApiState<ManagementServicesResponse> & { refetch: () => void }
  providers: UseApiState<ManagementProvidersResponse> & { refetch: () => void }
  management: GatewaySettingsController
  codexManagement: CodexSettingsController
  tasks: ManagementTaskController
  copiedCommand: string | null
  copyError: boolean
  onCopy: (id: string, command: string) => Promise<void>
}

function SettingsContent({ currency, settings, summary, services, providers, management, codexManagement, tasks, copiedCommand, copyError, onCopy }: SettingsContentProps) {
  return <>
    {management.loading ? <p className="text-sm text-muted-foreground">正在读取可编辑设置…</p> : null}
    {management.managedSettings === null && !management.loading ? <SettingsError message={management.error ?? "设置管理暂不可用"} retry={management.refetch} /> : null}
    <AppServerSettingsCard management={codexManagement} />
    {providers.loading ? <LoadingSettingsCard title="Provider 状态" /> : null}
    {providers.error ? <SettingsError message={providers.error} retry={providers.refetch} /> : null}
    {!providers.loading && providers.error === null && providers.data !== null ? <ProviderStatusCard state={providers.data} /> : null}
    <ApiProviderManagement />
    {management.pendingSetting !== null ? <PendingSettingCard pending={management.pendingSetting} saving={management.saving} onConfirm={() => void management.confirmSetting()} onCancel={management.cancelSetting} /> : null}
    {management.actionError !== null ? <p className="text-sm text-destructive" role="status">{management.actionError}</p> : null}
    <GatewaySettingsCard management={management} currency={currency} settings={settings} />
    <WebuiDataSettingsCard management={management} />
    <ChannelStatusCard channels={summary.gateway.channels} />
    {tasks.actionError !== null ? <p className="text-sm text-destructive" role="status">{tasks.actionError}</p> : null}
    <Card>
      <CardHeader><CardTitle>服务状态</CardTitle><CardDescription>状态、版本和最近错误由当前平台服务管理器查询；启停、重载和安装操作需要确认</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {services.loading ? <p className="text-sm text-muted-foreground">正在读取服务状态…</p> : null}
        {services.error ? <SettingsError message={services.error} retry={services.refetch} /> : null}
        {!services.loading && services.error === null && services.data !== null ? <ManagedServices services={services.data} tasks={tasks} /> : null}
      </CardContent>
    </Card>
    <ManagementTaskControls tasks={tasks} providerIds={[...(providers.data?.primary.id ? [providers.data.primary.id] : []), ...(providers.data?.providers.map((provider) => provider.id) ?? [])]} />
    <Card>
      <CardHeader><CardTitle>CLI 设置入口</CardTitle><CardDescription>尚未接入页面的凭据、渠道 Setup 和账户授权暂通过 CLI 管理</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {summary.cli.map((entry, index) => <Fragment key={entry.id}>{index > 0 ? <div className="h-px bg-border" /> : null}<CliCommandRow entry={entry} copied={copiedCommand === entry.id} onCopy={() => onCopy(entry.id, entry.command)} /></Fragment>)}
        {copyError ? <p className="text-xs text-destructive" role="status">浏览器未允许访问剪贴板，请手动选择并复制命令。</p> : null}
      </CardContent>
    </Card>
  </>
}
