import { Fragment, useEffect } from "react"
import { RefreshCwIcon } from "lucide-react"
import { useState } from "react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useCurrency } from "@/hooks/currency-context"
import { useApi } from "@/hooks/use-api"
import { fetchSettingsSummary } from "@/lib/api"
import { clearManagementSession, fetchManagementSettings, loginManagement, logoutManagement, onManagementUnauthorized, previewManagementSetting, updateManagementSetting } from "@/lib/api"
import { resolveSettingsLoadState } from "@/lib/settings-state"

export function SettingsPage() {
  const { currency, settings } = useCurrency()
  const summary = useApi(fetchSettingsSummary, [])
  const loadState = resolveSettingsLoadState(summary.data, summary.loading, summary.error)
  const [credential, setCredential] = useState("")
  const [management, setManagement] = useState<Awaited<ReturnType<typeof fetchManagementSettings>> | null>(null)
  const [managementError, setManagementError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pendingReasoning, setPendingReasoning] = useState<{ value: boolean; target: string } | null>(null)

  useEffect(() => onManagementUnauthorized(() => {
    setManagement(null)
    setPendingReasoning(null)
    setManagementError("管理会话已过期，请重新登录")
  }), [])

  async function signIn() {
    setManagementError(null)
    try { await loginManagement(credential); setCredential(""); setManagement(await fetchManagementSettings()) }
    catch (error) { setManagementError(error instanceof Error ? error.message : String(error)) }
  }

  async function saveReasoning(value: boolean) {
    if (management === null) return
    setSaving(true); setManagementError(null)
    try {
      const preview = await previewManagementSetting(management.revision, { kind: "display.reasoning", value })
      setPendingReasoning({ value, target: preview.activation.target })
    } catch (error) { setManagementError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }

  async function confirmReasoning() {
    if (management === null || pendingReasoning === null) return
    setSaving(true); setManagementError(null)
    try {
      await updateManagementSetting(management.revision, { kind: "display.reasoning", value: pendingReasoning.value })
      setPendingReasoning(null)
      setManagement(await fetchManagementSettings())
    } catch (error) { setManagementError(error instanceof Error ? error.message : String(error)) }
    finally { setSaving(false) }
  }

  async function signOut() {
    setSaving(true)
    try { await logoutManagement() } catch { /* 会话已失效时仍清理本地状态 */ }
    finally {
      clearManagementSession()
      setManagement(null)
      setPendingReasoning(null)
      setManagementError(null)
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">查看 WebUI 当前显示配置和 CLI 设置入口。</p>
      </div>
      {loadState === "loading" ? <SettingsSkeleton /> : null}
      {loadState === "error" ? <SettingsError message={summary.error ?? "设置快照加载失败"} retry={summary.refetch} /> : null}
      {loadState === "empty" ? <SettingsError message="服务未返回可用的设置快照" retry={summary.refetch} /> : null}
      {loadState === "ready" && summary.data !== null ? (
        <>
          <Card>
            <CardHeader><CardTitle>低风险设置管理</CardTitle><CardDescription>使用终端生成的独立管理凭据；凭据不会保存到浏览器。</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-4">
              {management === null ? <div className="flex flex-col gap-2 sm:flex-row"><Input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} placeholder="管理凭据" autoComplete="off" /><Button onClick={() => void signIn()} disabled={credential.length === 0}>登录管理接口</Button></div> : <div className="flex flex-col gap-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-3"><span>已登录，管理会话短期有效。思考状态：{management.display.reasoningEnabled ? "已启用" : "未启用"}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={saving || pendingReasoning !== null} onClick={() => void saveReasoning(!management.display.reasoningEnabled)}>{saving ? "预览中…" : "切换思考状态"}</Button><Button variant="ghost" size="sm" disabled={saving} onClick={() => void signOut()}>退出管理</Button></div></div>{pendingReasoning !== null ? <div className="rounded-lg border border-border bg-muted/40 p-3"><p>预览：思考状态将{pendingReasoning.value ? "启用" : "禁用"}。</p><p className="mt-1 text-muted-foreground">生效目标：{pendingReasoning.target}。保存不会自动重启服务。</p><div className="mt-3 flex gap-2"><Button size="sm" disabled={saving} onClick={() => void confirmReasoning()}>确认写入</Button><Button variant="outline" size="sm" disabled={saving} onClick={() => setPendingReasoning(null)}>取消</Button></div></div> : null}</div>}
              {managementError !== null ? <p className="text-sm text-destructive">{managementError}</p> : null}
            </CardContent>
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle>Gateway 与显示</CardTitle><CardDescription>当前配置文件的脱敏快照，部分变更需重启后生效</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <SettingsRow label="页面显示货币" value={(currency ?? summary.data.gateway.display.priceCurrency).toUpperCase()} badge />
                <SettingsRow label="服务端默认货币" value={summary.data.gateway.display.priceCurrency.toUpperCase()} />
                <SettingsRow label="美元兑人民币" value={settings?.exchangeRate?.usdToCny.toString() ?? "暂无"} />
                <SettingsRow label="汇率来源" value={exchangeRateSourceLabel(settings?.exchangeRate?.source)} />
                <SettingsRow label="Sandbox" value={summary.data.gateway.system.sandbox} />
                <SettingsRow label="默认 Workspace" value={summary.data.gateway.system.defaultWorkspace ?? "未配置"} />
                <SettingsRow label="渠道新会话模型" value={summary.data.gateway.system.defaultModel ?? "跟随 Provider"} />
                <SettingsRow label="审批超时" value={`${summary.data.gateway.system.approvalTimeoutSeconds} 秒`} />
                <SettingsRow label="操作详情" value={summary.data.gateway.display.operationUpdates} />
                <SettingsRow label="计划显示" value={enabledLabel(summary.data.gateway.display.planUpdatesEnabled)} />
                <SettingsRow label="思考状态" value={enabledLabel(summary.data.gateway.display.reasoningEnabled)} />
                <SettingsRow label="日志等级" value={summary.data.gateway.advanced.loggingLevel} />
                <SettingsRow label="Plugin API" value={enabledLabel(summary.data.gateway.advanced.pluginApiEnabled)} />
                <SettingsRow label="计划任务" value={enabledLabel(summary.data.gateway.automation.scheduledTasksEnabled)} />
                <SettingsRow label="通讯渠道" value={summary.data.gateway.channels.map((channel) => `${channel.displayName}（${enabledLabel(channel.enabled)}）`).join("、") || "未配置"} />
                <SettingsRow label="Thread 分区管理员" value={`${summary.data.gateway.automation.threadSectionAdministratorCount} 个`} />
                <SettingsRow label="配置修订" value={summary.data.revision.slice(0, 12)} code />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>WebUI 与数据中心</CardTitle><CardDescription>凭据只显示是否已配置</CardDescription></CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <SettingsRow label="WebUI 地址" value={formatHostPort(summary.data.gateway.webui.host, summary.data.gateway.webui.port)} />
                <SettingsRow label="WebUI 令牌" value={configuredLabel(summary.data.gateway.webui.tokenConfigured)} />
                <SettingsRow label="指标保留" value={`${summary.data.gateway.metrics.storage.retentionDays} 天 / 最多 ${summary.data.gateway.metrics.storage.maxRows.toLocaleString("zh-CN")} 行`} />
                <SettingsRow label="设备同步" value={enabledLabel(summary.data.gateway.metrics.sync.enabled)} />
                <SettingsRow label="设备上报令牌" value={configuredLabel(summary.data.gateway.metrics.sync.deviceTokenConfigured)} />
                <SettingsRow label="全局视图" value={enabledLabel(summary.data.gateway.metrics.view.enabled)} />
                <SettingsRow label="全局查看令牌" value={configuredLabel(summary.data.gateway.metrics.view.tokenConfigured)} />
                <SettingsRow label="数据中心" value={enabledLabel(summary.data.gateway.metrics.center.enabled)} />
                <SettingsRow label="中心地址" value={formatHostPort(summary.data.gateway.metrics.center.host, summary.data.gateway.metrics.center.port)} />
                <SettingsRow label="显式代理" value={summary.data.gateway.network.configuredFields.join("、") || "未配置"} />
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>服务状态</CardTitle><CardDescription>由当前平台服务管理器实时查询</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {summary.data.services.available ? summary.data.services.entries.map((service, index) => (
                <Fragment key={service.target}>
                  {index > 0 ? <Separator /> : null}
                  <div className="flex items-center justify-between gap-4 text-sm">
                    <div className="flex flex-col gap-0.5"><span className="font-medium">{service.name}</span><span className="text-xs text-muted-foreground">{service.state}{service.pid === null ? "" : ` · PID ${service.pid}`}</span></div>
                    <Badge variant={service.running ? "secondary" : "destructive"}>{serviceStatusLabel(service)}</Badge>
                  </div>
                </Fragment>
              )) : <span className="text-sm text-muted-foreground">当前平台服务状态不可用，请使用 CLI 查看。</span>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>CLI 设置入口</CardTitle><CardDescription>凭据、高权限和执行型操作暂通过 CLI 管理</CardDescription></CardHeader>
            <CardContent className="flex flex-col gap-3">
              {summary.data.cli.map((entry, index) => (
                <Fragment key={entry.id}>
                  {index > 0 ? <Separator /> : null}
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5"><span className="text-sm font-medium">{entry.label}</span><span className="text-xs text-muted-foreground">{entry.detail}</span></div>
                    <code className="rounded bg-muted px-2 py-1 text-xs">{entry.command}</code>
                  </div>
                </Fragment>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>当前管理边界</CardTitle><CardDescription>WebUI 暂不直接修改用户配置或执行 CLI</CardDescription></CardHeader>
            <CardContent className="text-sm text-muted-foreground">API Key、Token、扫码授权、Provider 变更、数据库维护、服务重启和源码更新，请在服务器终端运行对应的 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">codexc</code> 命令。</CardContent>
          </Card>
        </>
      ) : null}
    </div>
  )
}

function SettingsRow({ label, value, badge = false, code = false }: { label: string; value: string; badge?: boolean; code?: boolean }) {
  return <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">{label}</span>{badge ? <Badge variant="secondary">{value}</Badge> : code ? <code className="rounded bg-muted px-2 py-1 text-xs">{value}</code> : <span className="text-right">{value}</span>}</div>
}

function SettingsSkeleton() {
  return <div className="grid gap-6 lg:grid-cols-2" aria-label="正在加载设置快照"><Skeleton className="h-72 w-full" /><Skeleton className="h-72 w-full" /></div>
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
