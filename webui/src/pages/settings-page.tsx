import { Fragment, useEffect, useState } from "react"
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ChannelStatusCard, ProviderStatusCard } from "@/components/settings/provider-channel-status"
import { ApiProviderManagement } from "@/components/settings/api-provider-management"
import { ManagementTaskControls } from "@/components/settings/management-task-controls"
import { ManagedInputRow, ManagedSelect, PendingSettingCard, SettingsRow } from "@/components/settings/settings-controls"
import { useCurrency } from "@/hooks/currency-context"
import { useApi } from "@/hooks/use-api"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { useCodexSettingsManagement } from "@/hooks/use-codex-settings-management"
import { useManagementTasks } from "@/hooks/use-management-tasks"
import { fetchManagementProviders, fetchManagementServices, fetchSettingsSummary } from "@/lib/api"
import type { ManagementServicesResponse } from "@/lib/types"
import { resolveSettingsLoadState } from "@/lib/settings-state"

export function SettingsPage() {
  const { currency, settings } = useCurrency()
  const summary = useApi(fetchSettingsSummary, [])
  const services = useApi(fetchManagementServices, [])
  const providers = useApi(fetchManagementProviders, [])
  const management = useSettingsManagement()
  const codexManagement = useCodexSettingsManagement()
  const tasks = useManagementTasks()
  useEffect(() => {
    if (!tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))) return undefined
    const timer = window.setInterval(services.refetch, 2_000)
    return () => window.clearInterval(timer)
  }, [services.refetch, tasks.tasks])
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
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
  const { managedSettings, actionError, saving, pendingSetting, previewSetting, confirmSetting, cancelSetting } = management
  const loadState = resolveSettingsLoadState(summary.data, summary.loading, summary.error)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">按 App Server、Gateway 和 WebUI 边界查看并修改配置。</p>
      </div>
      {loadState === "loading" ? <SettingsSkeleton /> : null}
      {loadState === "error" ? <SettingsError message={summary.error ?? "设置快照加载失败"} retry={summary.refetch} /> : null}
      {loadState === "empty" ? <SettingsError message="服务未返回可用的设置快照" retry={summary.refetch} /> : null}
      {loadState === "ready" && summary.data !== null ? (
        <>
          {management.loading ? <p className="text-sm text-muted-foreground">正在读取可编辑设置…</p> : null}
          {managedSettings === null && !management.loading ? <SettingsError message={management.error ?? "设置管理暂不可用"} retry={management.refetch} /> : null}
          {pendingSetting !== null ? <PendingSettingCard pending={pendingSetting} saving={saving} onConfirm={() => void confirmSetting()} onCancel={cancelSetting} /> : null}
          <CodexSettingsCard management={codexManagement} />
          {providers.loading ? <Card><CardHeader><CardTitle>Provider 状态</CardTitle></CardHeader><CardContent className="flex flex-col gap-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></CardContent></Card> : null}
          {providers.error ? <SettingsError message={providers.error} retry={providers.refetch} /> : null}
          {!providers.loading && providers.error === null && providers.data !== null ? <ProviderStatusCard state={providers.data} /> : null}
          <ApiProviderManagement />
          {managedSettings !== null ? (
            <>
              <Card>
                <CardHeader><CardTitle>Gateway 设置</CardTitle><CardDescription>Gateway 渠道、系统、显示、自动化和运行日志；当前值与修改入口在同一分区。</CardDescription></CardHeader>
                <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
                  <ManagedSelect label="Sandbox" value={managedSettings.system.sandbox} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("system.sandbox", value, "Sandbox")} />
                  <ManagedSelect label="审批超时" value={String(managedSettings.system.approvalTimeoutSeconds)} options={[["300", "300 秒"], ["600", "600 秒"], ["900", "900 秒"], ["1800", "1800 秒"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("system.approval-timeout", Number(value), "审批超时")} />
                  <ManagedInputRow key={managedSettings.revision} label="渠道新会话模型" defaultValue={managedSettings.system.defaultModel ?? ""} placeholder="留空跟随 Codex 全局默认" disabled={saving || pendingSetting !== null} onBlur={(value) => void previewSetting("system.default-model", value === "" ? null : value, "渠道新会话模型")} />
                  <ManagedSelect label="默认 Workspace" value={managedSettings.system.defaultWorkspace ?? ""} options={managedSettings.system.workspaces.map((workspace) => [workspace.id, workspace.name])} disabled={saving || pendingSetting !== null || managedSettings.system.workspaces.length === 0} onChange={(value) => void previewSetting("system.default-workspace", value, "默认 Workspace")} />
                  <ManagedSelect label="操作详情" value={managedSettings.display.operationUpdates} options={[["full", "完整"], ["compact", "紧凑"], ["hidden", "隐藏"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.operation-updates", value, "操作详情")} />
                  <ManagedSelect label="计划更新" value={String(managedSettings.display.planUpdatesEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.plan-updates", value === "true", "计划更新")} />
                  <ManagedSelect label="思考状态" value={String(managedSettings.display.reasoningEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.reasoning", value === "true", "思考状态")} />
                  <ManagedSelect label="价格币种" value={managedSettings.display.priceCurrency} options={[["cny", "人民币"], ["usd", "美元"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.price-currency", value, "价格币种")} />
                  <ManagedSelect label="计划任务" value={String(managedSettings.automation.scheduledTasksEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("automation.scheduled-tasks", value === "true", "计划任务")} />
                  <ManagedSelect label="日志等级" value={managedSettings.advanced.loggingLevel} options={[["fatal", "fatal"], ["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"], ["trace", "trace"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("advanced.logging-level", value, "日志等级")} />
                  <SettingsRow label="当前页面货币" value={(currency ?? managedSettings.display.priceCurrency).toUpperCase()} badge />
                  <SettingsRow label="美元兑人民币" value={settings?.exchangeRate?.usdToCny.toString() ?? "暂无"} />
                  <SettingsRow label="汇率来源" value={exchangeRateSourceLabel(settings?.exchangeRate?.source)} />
                  <ManagedSelect label="Plugin API" value={String(managedSettings.advanced.pluginApiEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("advanced.plugin-api", value === "true", "Plugin API")} />
                  <SettingsRow label="Thread 分区管理员" value={`${managedSettings.automation.threadSectionAdministratorCount} 个`} />
                  <SettingsRow label="配置修订" value={managedSettings.revision.slice(0, 12)} code />
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>WebUI 与数据中心设置</CardTitle><CardDescription>监听和指标同步参数可修改；凭据只显示是否已配置。</CardDescription></CardHeader>
                <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
                  <ManagedSelect label="指标保留" value={String(managedSettings.metrics.storage.retentionDays)} options={[["30", "30 天"], ["90", "90 天"], ["365", "365 天"], ["730", "730 天"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("metrics.storage", { retentionDays: Number(value), maxRows: managedSettings.metrics.storage.maxRows }, "指标保留")} />
                  <ManagedSelect label="上报间隔" value={String(managedSettings.metrics.sync.intervalSeconds)} options={[["30", "30 秒"], ["60", "60 秒"], ["300", "5 分钟"], ["900", "15 分钟"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("metrics.sync-params", { intervalSeconds: Number(value), batchSize: managedSettings.metrics.sync.batchSize }, "上报间隔")} />
                  <ManagedSelect label="批量大小" value={String(managedSettings.metrics.sync.batchSize)} options={[["50", "50 条"], ["100", "100 条"], ["200", "200 条"], ["500", "500 条"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("metrics.sync-params", { intervalSeconds: managedSettings.metrics.sync.intervalSeconds, batchSize: Number(value) }, "批量大小")} />
                  <ManagedSelect label="WebUI 端口" value={String(managedSettings.webui.port)} options={[["8787", "8787"], ["8790", "8790"], ["8800", "8800"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("webui.port", Number(value), "WebUI 端口")} />
                  <ManagedSelect label="WebUI 监听地址" value={managedSettings.webui.host} options={[["127.0.0.1", "127.0.0.1"], ["::1", "::1"], ["0.0.0.0", "0.0.0.0"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("webui.host", value, "WebUI 监听地址")} />
                  <ManagedInputRow label="WebUI 访问令牌" type="password" defaultValue="" placeholder={managedSettings.webui.tokenConfigured ? "留空保持不变" : "输入新令牌"} disabled={saving || pendingSetting !== null} onBlur={(value) => { if (value !== "") void previewSetting("webui.token", { action: "set", value }, "WebUI 访问令牌") }} />
                  <SettingsRow label="WebUI 令牌" value={configuredLabel(managedSettings.webui.tokenConfigured)} />
                  <SettingsRow label="设备同步" value={enabledLabel(managedSettings.metrics.sync.enabled)} />
                  <SettingsRow label="设备上报令牌" value={configuredLabel(managedSettings.metrics.sync.deviceTokenConfigured)} />
                  <SettingsRow label="全局视图" value={enabledLabel(managedSettings.metrics.view.enabled)} />
                  <SettingsRow label="全局查看令牌" value={configuredLabel(managedSettings.metrics.view.tokenConfigured)} />
                  <SettingsRow label="数据中心" value={enabledLabel(managedSettings.metrics.center.enabled)} />
                  <SettingsRow label="中心地址" value={formatHostPort(managedSettings.metrics.center.host, managedSettings.metrics.center.port)} />
                  <SettingsRow label="显式代理" value={managedSettings.network.configuredFields.join("、") || "未配置"} />
                </CardContent>
              </Card>
            </>
          ) : null}
          <ChannelStatusCard channels={summary.data.gateway.channels} />
          {actionError !== null ? <p className="text-sm text-destructive">{actionError}</p> : null}
          <Card>
            <CardHeader><CardTitle>服务状态</CardTitle><CardDescription>状态、版本和最近错误由当前平台服务管理器查询；启停、重载和安装操作需要确认</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {services.loading ? <><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></> : null}
              {services.error ? <SettingsError message={services.error} retry={services.refetch} /> : null}
              {!services.loading && services.error === null && services.data !== null
                ? <ManagedServices services={services.data} tasks={tasks} />
                : null}
              {tasks.actionError !== null ? <p className="text-sm text-destructive" role="status">{tasks.actionError}</p> : null}
            </CardContent>
          </Card>
          <ManagementTaskControls
            tasks={tasks}
            providerIds={[...(providers.data?.primary.id ? [providers.data.primary.id] : []), ...(providers.data?.providers.map((provider) => provider.id) ?? [])]}
          />
          <Card>
            <CardHeader><CardTitle>CLI 设置入口</CardTitle><CardDescription>尚未接入页面的凭据、渠道 Setup 和账户授权暂通过 CLI 管理</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {summary.data.cli.map((entry, index) => (
                <Fragment key={entry.id}>
                  {index > 0 ? <Separator /> : null}
                  <CliCommandRow
                    entry={entry}
                    copied={copiedCommand === entry.id}
                    onCopy={() => void copyCommand(entry.id, entry.command)}
                  />
                </Fragment>
              ))}
              {copyError ? <p className="text-xs text-destructive" role="status">浏览器未允许访问剪贴板，请手动选择并复制命令。</p> : null}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}

function CodexSettingsCard({ management }: { management: ReturnType<typeof useCodexSettingsManagement> }) {
  const settings = management.codexSettings
  if (management.loading) return <Card><CardHeader><CardTitle>App Server 设置</CardTitle></CardHeader><CardContent><Skeleton className="h-28 w-full" /></CardContent></Card>
  if (settings === null) return <SettingsError message={management.error ?? "App Server 用户设置暂不可用"} retry={management.refetch} />
  const selected = settings.models.find((model) => model.model === settings.defaults.model) ?? settings.models[0]
  const effortOptions = selected?.reasoningEfforts.map((item) => [item.effort, item.effort]) ?? []
  const disabled = management.saving || management.pendingSetting !== null || !settings.defaultsEditable
  return <>
    {management.pendingSetting !== null ? <PendingSettingCard pending={management.pendingSetting} saving={management.saving} onConfirm={() => void management.confirmSetting()} onCancel={management.cancelSetting} /> : null}
    <Card>
      <CardHeader><CardTitle>App Server 设置</CardTitle><CardDescription>通过 App Server 用户配置 RPC 写入，修订冲突会要求重新读取；写入后需重启全部服务生效。</CardDescription></CardHeader>
      <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
        <SettingsRow label="当前 Provider" value={settings.provider} badge />
        <ManagedSelect label="默认模型" value={settings.defaults.model ?? ""} options={settings.models.map((model) => [model.model, model.displayName])} disabled={disabled} onChange={(value) => { const model = settings.models.find((candidate) => candidate.model === value); void management.previewSetting({ kind: "defaults", model: value, reasoningEffort: model?.defaultReasoningEffort ?? "medium" }, "默认模型") }} />
        <ManagedSelect label="思考等级" value={settings.defaults.reasoningEffort ?? ""} options={effortOptions} disabled={disabled || selected === undefined} onChange={(value) => void management.previewSetting({ kind: "defaults", model: selected?.model ?? "", reasoningEffort: value }, "思考等级")} />
        <ManagedSelect label="Fast" value={String(settings.defaults.fastEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={disabled} onChange={(value) => void management.previewSetting({ kind: "fast", enabled: value === "true" }, "Fast")} />
        <ManagedSelect label="联网搜索" value={settings.defaults.webSearch ?? "disabled"} options={[["live", "实时"], ["indexed", "索引"], ["cached", "缓存"], ["disabled", "关闭"]]} disabled={management.saving || management.pendingSetting !== null} onChange={(value) => void management.previewSetting({ kind: "web-search", mode: value }, "联网搜索")} />
        <ManagedSelect label="计划清单工具" value={String(settings.defaults.updatePlanEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={management.saving || management.pendingSetting !== null} onChange={(value) => void management.previewSetting({ kind: "update-plan", enabled: value === "true" }, "计划清单工具")} />
        <ManagedSelect label="Sandbox" value={settings.permissions.sandboxMode ?? "read-only"} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={management.saving || management.pendingSetting !== null || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: value, approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: settings.permissions.networkAccess ?? false }, "Sandbox")} />
        <ManagedSelect label="审批策略" value={settings.permissions.approvalPolicy ?? "on-request"} options={[["on-request", "按需"], ["never", "从不"]]} disabled={management.saving || management.pendingSetting !== null || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: value, networkAccess: settings.permissions.networkAccess ?? false }, "审批策略")} />
        <ManagedSelect label="网络访问" value={String(settings.permissions.networkAccess ?? false)} options={[["true", "已允许"], ["false", "已禁止"]]} disabled={management.saving || management.pendingSetting !== null || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: value === "true" }, "网络访问")} />
        <SettingsRow label="Permission Profile" value={settings.permissions.defaultPermissions ?? "未配置"} code />
        {management.actionError !== null ? <p className="text-sm text-destructive md:col-span-2">{management.actionError}</p> : null}
      </CardContent>
    </Card>
  </>
}

function ManagedServices({ services, tasks }: { services: ManagementServicesResponse; tasks: ReturnType<typeof useManagementTasks> }) {
  if (services.entries.length === 0) {
    return <span className="text-sm text-muted-foreground">当前平台没有可展示的受管服务。</span>
  }
  const taskBusy = tasks.loading || tasks.tasks.some((task) => ["queued", "running", "cancelling"].includes(task.state))
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={taskBusy || services.platform === null} onClick={() => void tasks.run({ operation: "service", action: "install" })}>安装全部服务</Button>
        <Button variant="outline" size="sm" disabled={taskBusy || services.platform === null} onClick={() => void tasks.run({ operation: "service", action: "uninstall" })}>卸载全部服务</Button>
      </div>
      {services.entries.map((service, index) => (
        <Fragment key={service.target}>
          {index > 0 ? <Separator /> : null}
          <div className="flex flex-col gap-1 text-sm">
            <div className="flex items-center justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{service.name}</span>
                <span className="text-xs text-muted-foreground">
                  {service.state}
                  {service.version === null ? " · 版本未知" : ` · ${service.version}`}
                  {service.pid === null ? "" : ` · PID ${service.pid}`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={service.running ? "secondary" : "destructive"}>{serviceStatusLabel(service)}</Badge>
                <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: service.running ? "restart" : "start", target: service.target })}>{service.running ? "重启" : "启动"}</Button>
                {service.target === "gateway" ? <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: "reload" })}>重载</Button> : null}
                {service.running ? <Button variant="outline" size="sm" disabled={taskBusy} onClick={() => void tasks.run({ operation: "service", action: "stop", target: service.target })}>停止</Button> : null}
              </div>
            </div>
            {service.recentError !== null ? (
              <p className="text-xs text-destructive">最近错误：{service.recentError.message}</p>
            ) : null}
          </div>
        </Fragment>
      ))}
      {services.platform === null ? <p className="text-xs text-muted-foreground">当前平台服务状态不可用，请使用 CLI 查看详细信息。</p> : null}
      {tasks.error !== null ? <p className="mt-2 text-xs text-destructive" role="status">任务状态读取失败：{tasks.error}</p> : null}
      {tasks.tasks.length > 0 ? <div className="mt-2 rounded-md border p-2 text-xs"><span className="font-medium">最近管理任务</span>{tasks.tasks.slice(-3).map((task) => <div key={task.id} className="mt-1 flex items-center justify-between gap-2"><span>{task.operation}:{task.action}{task.target ? `:${task.target}` : ""}</span><div className="flex items-center gap-2"><Badge variant={task.state === "completed" ? "secondary" : task.state === "failed" ? "destructive" : "outline"}>{task.state}</Badge>{["queued", "running", "cancelling"].includes(task.state) ? <Button variant="ghost" size="sm" disabled={tasks.loading || task.state === "cancelling"} onClick={() => void tasks.cancel(task.id)}>取消</Button> : null}</div></div>)}</div> : null}
    </>
  )
}

function CliCommandRow({
  entry,
  copied,
  onCopy,
}: {
  entry: { label: string; command: string; detail: string }
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium">{entry.label}</span>
        <span className="text-xs text-muted-foreground">{entry.detail} · 请在服务器终端执行</span>
      </div>
      <div className="flex items-center gap-2">
        <code className="rounded bg-muted px-2 py-1 text-xs">{entry.command}</code>
        <Button type="button" variant="outline" size="sm" onClick={onCopy} aria-label={`复制命令：${entry.command}`}>
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? "已复制" : "复制"}
        </Button>
      </div>
    </div>
  )
}

function SettingsSkeleton() {
  return <div className="grid gap-6" aria-label="正在加载设置快照"><Skeleton className="h-48 w-full" /><Skeleton className="h-72 w-full" /><Skeleton className="h-72 w-full" /></div>
}

function SettingsError({ message, retry }: { message: string; retry: () => void }) {
  return <Alert variant="destructive"><AlertTitle>设置快照加载失败</AlertTitle><AlertDescription>{message}</AlertDescription><AlertAction><Button variant="outline" size="sm" onClick={retry}><RefreshCwIcon data-icon="inline-start" />重试</Button></AlertAction></Alert>
}

function enabledLabel(value: boolean): string { return value ? "已启用" : "未启用" }
function configuredLabel(value: boolean): string { return value ? "已配置" : "未配置" }
function serviceStatusLabel(service: { loaded: boolean; running: boolean; state: string }): string {
  if (service.running) return "运行中"
  if (service.state === "unavailable") return "状态不可用"
  return service.loaded ? "已停止" : "未安装"
}
function formatHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
}
function exchangeRateSourceLabel(value: "open-er-api" | "ecb" | "cache" | undefined): string {
  if (value === "open-er-api") return "Open Exchange Rate API"
  if (value === "ecb") return "欧洲中央银行"
  return value === "cache" ? "本地缓存" : "暂无"
}
