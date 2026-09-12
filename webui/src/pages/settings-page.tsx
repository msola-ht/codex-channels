import { Fragment, useCallback, useEffect, useRef, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { ChannelStatusCard, ProviderStatusCard } from "@/components/settings/provider-channel-status"
import { ProviderSettingsManagement } from "@/components/settings/provider-settings-management"
import { AccountSettingsManagement } from "@/components/settings/account-settings-management"
import { CliCommandRow } from "@/components/settings/cli-command-row"
import { GatewaySettingsCard } from "@/components/settings/gateway-settings-card"
import { ManagementTaskControls } from "@/components/settings/management-task-controls"
import { ManagedServices } from "@/components/settings/managed-services"
import { PendingSettingDialog } from "@/components/settings/settings-controls"
import { WebuiDataSettingsCard } from "@/components/settings/webui-data-settings-card"
import { WorkspaceSettingsCard } from "@/components/settings/workspace-settings-card"
import { SettingsError, SettingsSkeleton, LoadingSettingsCard } from "@/components/settings/settings-feedback"
import type { UseApiState } from "@/hooks/use-api"
import { useApi } from "@/hooks/use-api"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useManagementTasks } from "@/hooks/use-management-tasks"
import { useProviderSettingsManagement } from "@/hooks/use-provider-settings-management"
import { useAccountSettingsManagement } from "@/hooks/use-account-settings-management"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { fetchManagementProviders, fetchManagementServices, fetchSettingsSummary } from "@/lib/api"
import { resolveSettingsLoadState } from "@/lib/settings-state"
import type { ManagementProvidersResponse, ManagementServicesResponse, SettingsSummaryResponse } from "@/lib/types"
import type { AccountSettingsController, CodexSettingsController, GatewaySettingsController, ManagementTaskController, ProviderSettingsController } from "@/lib/settings-management"

type SettingsRefreshSource = "gateway" | "codex" | "provider" | "account"

const VISIBLE_REFRESH_MIN_INTERVAL_MS = 5_000

export function SettingsPage() {
  const summary = useApi(fetchSettingsSummary, [])
  const services = useApi(fetchManagementServices, [])
  const providers = useApi(fetchManagementProviders, [])
  const management = useSettingsManagement()
  const codexManagement = useCodexSettingsManagement()
  const tasks = useManagementTasks()
  const providerSettings = useProviderSettingsManagement()
  const accountSettings = useAccountSettingsManagement()
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const refetchSummary = summary.refetch
  const refetchServices = services.refetch
  const refetchProviders = providers.refetch
  const refetchManagedSettings = management.refetch
  const refetchCodexSettings = codexManagement.refetch
  const refetchProviderSettings = providerSettings.refetch
  const refetchAccountSettings = accountSettings.refetch
  const summaryLoaded = summary.data !== null
  const lastVisibleRefreshAt = useRef(0)
  const refreshAllSettings = useCallback((source?: SettingsRefreshSource) => {
    refetchSummary()
    refetchServices()
    refetchProviders()
    if (source !== "gateway") refetchManagedSettings()
    if (source !== "codex") refetchCodexSettings()
    if (source !== "provider") refetchProviderSettings()
    if (source !== "account") refetchAccountSettings()
  }, [refetchAccountSettings, refetchCodexSettings, refetchManagedSettings, refetchProviderSettings, refetchProviders, refetchServices, refetchSummary])

  useEffect(() => {
    if (!tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))) return undefined
    const timer = window.setInterval(services.refetch, 2_000)
    return () => window.clearInterval(timer)
  }, [services.refetch, tasks.tasks])

  const refreshVisibleSettings = useCallback(() => {
    if (!summaryLoaded || document.visibilityState !== "visible") return
    const now = Date.now()
    if (now - lastVisibleRefreshAt.current < VISIBLE_REFRESH_MIN_INTERVAL_MS) return
    lastVisibleRefreshAt.current = now
    refreshAllSettings()
  }, [refreshAllSettings, summaryLoaded])

  useEffect(() => {
    const handleVisibilityChange = () => refreshVisibleSettings()
    document.addEventListener("visibilitychange", handleVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange)
    }
  }, [refreshVisibleSettings])

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
      summary={summary.data}
      services={services}
      providers={providers}
      management={management}
      codexManagement={codexManagement}
      tasks={tasks}
      providerSettings={providerSettings}
      accountSettings={accountSettings}
      onSettingsChanged={refreshAllSettings}
      copiedCommand={copiedCommand}
      copyError={copyError}
      onCopy={copyCommand}
    /> : null}
  </div>
}

interface SettingsContentProps {
  summary: SettingsSummaryResponse
  services: UseApiState<ManagementServicesResponse> & { refetch: () => void }
  providers: UseApiState<ManagementProvidersResponse> & { refetch: () => void }
  management: GatewaySettingsController
  codexManagement: CodexSettingsController
  tasks: ManagementTaskController
  providerSettings: ProviderSettingsController
  accountSettings: AccountSettingsController
  onSettingsChanged: (source?: SettingsRefreshSource) => void
  copiedCommand: string | null
  copyError: boolean
  onCopy: (id: string, command: string) => Promise<void>
}

function SettingsContent({ summary, services, providers, management, codexManagement, tasks, providerSettings, accountSettings, onSettingsChanged, copiedCommand, copyError, onCopy }: SettingsContentProps) {
  const confirmGatewaySetting = async () => {
    if (await management.confirmSetting()) onSettingsChanged("gateway")
  }
  return <>
    {management.loading ? <p className="text-sm text-muted-foreground">正在读取可编辑设置…</p> : null}
    {management.managedSettings === null && !management.loading ? <SettingsError message={management.error ?? "设置管理暂不可用"} retry={management.refetch} /> : null}
    <AppServerSettingsCard management={codexManagement} onChanged={() => onSettingsChanged("codex")} />
    {providers.loading && providers.data === null ? <LoadingSettingsCard title="Provider 状态" /> : null}
    {providers.error ? <SettingsError message={providers.error} retry={providers.refetch} /> : null}
    {providers.error === null && providers.data !== null ? <ProviderStatusCard state={providers.data} /> : null}
    <ProviderSettingsManagement management={providerSettings} onChanged={() => onSettingsChanged("provider")} />
    <AccountSettingsManagement management={accountSettings} onChanged={() => onSettingsChanged("account")} />
    <PendingSettingDialog pending={management.pendingSetting} saving={management.saving} onConfirm={() => void confirmGatewaySetting()} onCancel={management.cancelSetting} />
    {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
    <GatewaySettingsCard management={management} />
    <WorkspaceSettingsCard management={management} />
    <WebuiDataSettingsCard management={management} />
    <ChannelStatusCard channels={summary.gateway.channels} />
    {tasks.actionError !== null ? <Alert variant="destructive"><AlertDescription>{tasks.actionError}</AlertDescription></Alert> : null}
    <Card>
      <CardHeader><CardTitle>服务状态</CardTitle><CardDescription>状态和版本由当前平台服务管理器查询，未运行时显示最近错误；启停、重载和安装操作需要确认</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {services.loading ? <p className="text-sm text-muted-foreground">正在读取服务状态…</p> : null}
        {services.error ? <SettingsError message={services.error} retry={services.refetch} /> : null}
        {services.error === null && services.data !== null ? <ManagedServices services={services.data} tasks={tasks} /> : null}
      </CardContent>
    </Card>
    <ManagementTaskControls tasks={tasks} providerIds={[...(providers.data?.primary.id ? [providers.data.primary.id] : []), ...(providers.data?.providers.map((provider) => provider.id) ?? [])]} />
    <Card>
      <CardHeader><CardTitle>CLI 与独立授权入口</CardTitle><CardDescription>需要终端身份流的官方登录、渠道 OAuth/扫码和项目技能仍通过对应 CLI 流程管理</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {summary.cli.map((entry, index) => <Fragment key={entry.id}>{index > 0 ? <Separator /> : null}<CliCommandRow entry={entry} copied={copiedCommand === entry.id} onCopy={() => onCopy(entry.id, entry.command)} /></Fragment>)}
        {copyError ? <Alert variant="destructive"><AlertDescription>浏览器未允许访问剪贴板，请手动选择并复制命令。</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  </>
}
