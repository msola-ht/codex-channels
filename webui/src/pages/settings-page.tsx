import { Fragment, useState } from "react"
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { ManagedInputRow, ManagedSelect, PendingSettingCard, SettingsRow } from "@/components/settings/settings-controls"
import { useCurrency } from "@/hooks/currency-context"
import { useApi } from "@/hooks/use-api"
import { useSettingsManagement } from "@/hooks/use-settings-management"
import { fetchManagementServices, fetchSettingsSummary } from "@/lib/api"
import type { ManagementServicesResponse } from "@/lib/types"
import { resolveSettingsLoadState } from "@/lib/settings-state"

export function SettingsPage() {
  const { currency, settings } = useCurrency()
  const summary = useApi(fetchSettingsSummary, [])
  const services = useApi(fetchManagementServices, [])
  const management = useSettingsManagement()
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
          <Card>
            <CardHeader><CardTitle>App Server 设置</CardTitle><CardDescription>App Server 用户默认值、Provider 和账户由 codexc setup 管理；当前 WebUI 不直接修改这部分配置。</CardDescription></CardHeader>
            <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
              <SettingsRow label="用户默认值" value="codexc setup" code />
              <SettingsRow label="Provider 与账户" value="codexc setup" code />
            </CardContent>
          </Card>
          {managedSettings !== null ? (
            <>
              <Card>
                <CardHeader><CardTitle>Gateway 设置</CardTitle><CardDescription>Gateway 渠道、系统、显示、自动化和运行日志；当前值与修改入口在同一分区。</CardDescription></CardHeader>
                <CardContent className="grid gap-x-8 gap-y-3 text-sm md:grid-cols-2">
                  <ManagedSelect label="Sandbox" value={managedSettings.system.sandbox} options={[["read-only", "只读"], ["workspace-write", "工作区可写"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("system.sandbox", value, "Sandbox")} />
                  <ManagedSelect label="审批超时" value={String(managedSettings.system.approvalTimeoutSeconds)} options={[["300", "300 秒"], ["600", "600 秒"], ["900", "900 秒"], ["1800", "1800 秒"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("system.approval-timeout", Number(value), "审批超时")} />
                  <ManagedInputRow key={managedSettings.revision} label="渠道新会话模型" defaultValue={managedSettings.system.defaultModel ?? ""} placeholder="留空跟随 Codex 全局默认" disabled={saving || pendingSetting !== null} onBlur={(value) => void previewSetting("system.default-model", value === "" ? null : value, "渠道新会话模型")} />
                  <SettingsRow label="默认 Workspace" value={managedSettings.system.defaultWorkspace ?? "未配置"} />
                  <ManagedSelect label="操作详情" value={managedSettings.display.operationUpdates} options={[["full", "完整"], ["compact", "紧凑"], ["hidden", "隐藏"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.operation-updates", value, "操作详情")} />
                  <ManagedSelect label="计划更新" value={String(managedSettings.display.planUpdatesEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.plan-updates", value === "true", "计划更新")} />
                  <ManagedSelect label="思考状态" value={String(managedSettings.display.reasoningEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.reasoning", value === "true", "思考状态")} />
                  <ManagedSelect label="价格币种" value={managedSettings.display.priceCurrency} options={[["cny", "人民币"], ["usd", "美元"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("display.price-currency", value, "价格币种")} />
                  <ManagedSelect label="计划任务" value={String(managedSettings.automation.scheduledTasksEnabled)} options={[["true", "已启用"], ["false", "未启用"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("automation.scheduled-tasks", value === "true", "计划任务")} />
                  <ManagedSelect label="日志等级" value={managedSettings.advanced.loggingLevel} options={[["fatal", "fatal"], ["error", "error"], ["warn", "warn"], ["info", "info"], ["debug", "debug"], ["trace", "trace"]]} disabled={saving || pendingSetting !== null} onChange={(value) => void previewSetting("advanced.logging-level", value, "日志等级")} />
                  <SettingsRow label="当前页面货币" value={(currency ?? managedSettings.display.priceCurrency).toUpperCase()} badge />
                  <SettingsRow label="美元兑人民币" value={settings?.exchangeRate?.usdToCny.toString() ?? "暂无"} />
                  <SettingsRow label="汇率来源" value={exchangeRateSourceLabel(settings?.exchangeRate?.source)} />
                  <SettingsRow label="Plugin API" value={enabledLabel(managedSettings.advanced.pluginApiEnabled)} />
                  <SettingsRow label="通讯渠道" value={managedSettings.channels.map((channel) => `${channel.displayName}（${enabledLabel(channel.enabled)}）`).join("、") || "未配置"} />
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
                  <SettingsRow label="监听地址" value={managedSettings.webui.host} />
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
          {actionError !== null ? <p className="text-sm text-destructive">{actionError}</p> : null}
          <Card>
            <CardHeader><CardTitle>服务状态</CardTitle><CardDescription>状态、版本和最近错误由当前平台服务管理器只读查询</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {services.loading ? <><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></> : null}
              {services.error ? <SettingsError message={services.error} retry={services.refetch} /> : null}
              {!services.loading && services.error === null && services.data !== null
                ? <ManagedServices services={services.data} />
                : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>CLI 设置入口</CardTitle><CardDescription>凭据、高权限和执行型操作暂通过 CLI 管理</CardDescription></CardHeader>
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
          <Card>
            <CardHeader><CardTitle>当前管理边界</CardTitle><CardDescription>WebUI 只修改上方已开放的低风险设置，不执行 CLI</CardDescription></CardHeader>
            <CardContent className="text-sm text-muted-foreground">WebUI 只修改上方已开放的低风险设置。API Key、Token、扫码授权、Provider 变更、数据库维护、服务重启和源码更新，请在服务器终端运行对应的 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">codexc</code> 命令。</CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}

function ManagedServices({ services }: { services: ManagementServicesResponse }) {
  if (services.entries.length === 0) {
    return <span className="text-sm text-muted-foreground">当前平台没有可展示的受管服务。</span>
  }
  return (
    <>
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
              <Badge variant={service.running ? "secondary" : "destructive"}>{serviceStatusLabel(service)}</Badge>
            </div>
            {service.recentError !== null ? (
              <p className="text-xs text-destructive">最近错误：{service.recentError.message}</p>
            ) : null}
          </div>
        </Fragment>
      ))}
      {services.platform === null ? <p className="text-xs text-muted-foreground">当前平台服务状态不可用，请使用 CLI 查看详细信息。</p> : null}
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
