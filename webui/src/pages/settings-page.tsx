import { Fragment } from "react"
import { RefreshCwIcon } from "lucide-react"

import { useCurrency } from "@/hooks/currency-context"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { resolveSettingsLoadState } from "@/lib/settings-state"

const cliGroups = [
  { label: "Gateway 与显示", command: "codexc config", detail: "进入 Gateway、显示和 WebUI 设置" },
  { label: "Codex 默认值与 Provider", command: "codexc setup", detail: "进入 Codex 与 Provider 设置" },
  { label: "通讯渠道", command: "codexc setup", detail: "菜单路径：通讯渠道" },
  { label: "数据中心", command: "codexc config", detail: "菜单路径：数据中心" },
  { label: "查看服务状态", command: "codexc service status all", detail: "查看全部受管服务" },
  { label: "重启全部服务", command: "codexc service restart all", detail: "配置变更需要整体生效时使用" },
] as const

const exchangeRateSourceLabels = {
  "open-er-api": "Open Exchange Rate API",
  ecb: "欧洲中央银行",
  cache: "本地缓存",
} as const

export function SettingsPage() {
  const {
    currency,
    settings,
    settingsLoading,
    settingsError,
    refetchSettings,
  } = useCurrency()
  const loadState = resolveSettingsLoadState(settings, settingsLoading, settingsError)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">设置</h1>
        <p className="text-sm text-muted-foreground">查看 WebUI 当前显示配置和 CLI 设置入口。</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>显示配置</CardTitle><CardDescription>当前页面使用的显示偏好（浏览器选择优先）。</CardDescription></CardHeader>
          <CardContent className="text-sm">
            {loadState === "loading" ? (
              <div className="flex flex-col gap-3" aria-label="正在加载显示配置">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : null}
            {loadState === "error" ? (
              <Alert variant="destructive">
                <AlertTitle>显示配置加载失败</AlertTitle>
                <AlertDescription>{settingsError}</AlertDescription>
                <AlertAction>
                  <Button variant="outline" size="sm" onClick={refetchSettings}>
                    <RefreshCwIcon data-icon="inline-start" />
                    重试
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            {loadState === "empty" ? (
              <Alert>
                <AlertTitle>暂无显示配置</AlertTitle>
                <AlertDescription>服务未返回可用的显示配置，请稍后重试。</AlertDescription>
                <AlertAction>
                  <Button variant="outline" size="sm" onClick={refetchSettings}>
                    <RefreshCwIcon data-icon="inline-start" />
                    重试
                  </Button>
                </AlertAction>
              </Alert>
            ) : null}
            {loadState === "ready" && settings !== null ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">页面显示货币</span><Badge variant="secondary">{(currency ?? settings.currency).toUpperCase()}</Badge></div>
                <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">服务端默认货币</span><span>{settings.currency.toUpperCase()}</span></div>
                <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">汇率来源</span><span>{settings.exchangeRate === null ? "暂无" : exchangeRateSourceLabels[settings.exchangeRate.source]}</span></div>
                <div className="flex items-center justify-between gap-4"><span className="text-muted-foreground">美元兑人民币</span><span className="tabular-nums">{settings.exchangeRate?.usdToCny ?? "暂无"}</span></div>
              </div>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>CLI 设置入口</CardTitle><CardDescription>凭据、高权限和执行型操作暂通过 CLI 管理。</CardDescription></CardHeader>
          <CardContent className="flex flex-col gap-3">
            {cliGroups.map((entry, index) => (
              <Fragment key={entry.label}>
                {index > 0 ? <Separator /> : null}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{entry.label}</span>
                    <span className="text-xs text-muted-foreground">{entry.detail}</span>
                  </div>
                  <code className="rounded bg-muted px-2 py-1 text-xs">{entry.command}</code>
                </div>
              </Fragment>
            ))}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle>当前管理边界</CardTitle><CardDescription>WebUI 暂不直接修改用户配置或执行 CLI。</CardDescription></CardHeader>
        <CardContent className="text-sm text-muted-foreground">API Key、Token、扫码授权、Provider 变更、数据库维护、服务重启和源码更新，请在服务器终端运行对应的 <code className="rounded bg-muted px-1.5 py-0.5 text-xs">codexc</code> 命令。</CardContent>
      </Card>
    </div>
  )
}
