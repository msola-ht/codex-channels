import { useState } from "react"

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { RangeSelector } from "@/components/metrics/range-selector"
import { StatCard } from "@/components/metrics/stat-card"
import {
  DeepseekBalanceCard,
  ErrorsSummary,
  GlobalCards,
  ProviderTable,
  WeeklyQuotaCard,
} from "@/components/overview/overview-sections"
import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { useOverview } from "@/hooks/use-overview"
import {
  fetchDeepseekBalance,
  fetchGlobalDevices,
  fetchGlobalOverview,
  fetchSettings,
} from "@/lib/api"
import { formatTime, formatTokens } from "@/lib/format"
import type {
  DeepseekBalanceResponse,
  GlobalCostRow,
  GlobalDeviceRow,
  GlobalOverviewResponse,
  GlobalProviderRow,
  SettingsResponse,
  RangeName,
} from "@/lib/types"

const SCOPE_STORAGE_KEY = "codex-webui:scope"

type Scope =
  | { kind: "all" }
  | { kind: "local" }
  | { kind: "device"; deviceId: string }

function scopeValue(scope: Scope): string {
  return scope.kind === "device" ? `device:${scope.deviceId}` : scope.kind
}

function readScope(): Scope {
  try {
    const raw = window.localStorage.getItem(SCOPE_STORAGE_KEY)
    if (raw === "all") return { kind: "all" }
    if (raw === "local") return { kind: "local" }
    if (raw?.startsWith("device:")) {
      const deviceId = raw.slice("device:".length)
      if (deviceId) return { kind: "device", deviceId }
    }
  } catch {
    // 存储不可用时默认全部设备
  }
  return { kind: "all" }
}

function persistScope(scope: Scope) {
  try {
    window.localStorage.setItem(SCOPE_STORAGE_KEY, scopeValue(scope))
  } catch {
    // 存储不可用时仅在本次会话内保留
  }
}

export function ConsolePage() {
  const [scope, setScope] = useState<Scope>(readScope)
  const devices = useApi((signal) => fetchGlobalDevices(signal), [])
  const account = useOverview("24h")
  const settings = useApi((signal) => fetchSettings(signal), [])
  const balance = useApi((signal) => fetchDeepseekBalance(signal), [])
  const deviceLabel = (deviceId: string) =>
    devices.data?.devices.find((device) => device.device_id === deviceId)
      ?.display_name ?? deviceId
  const scopeLabel = scope.kind === "all"
    ? "全部设备的中心累计用量"
    : scope.kind === "local"
      ? "本机指标库与账户状态"
      : `${deviceLabel(scope.deviceId)} 的中心累计用量`

  const changeScope = (value: string) => {
    const next: Scope = value === "all"
      ? { kind: "all" }
      : value === "local"
        ? { kind: "local" }
        : { kind: "device", deviceId: value.slice("device:".length) }
    setScope(next)
    persistScope(next)
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">控制台</h1>
          <p className="text-sm text-muted-foreground">{scopeLabel}</p>
        </div>
        <Select value={scopeValue(scope)} onValueChange={changeScope}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="选择数据范围" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部设备</SelectItem>
            <SelectItem value="local">本机</SelectItem>
            {devices.data?.devices.map((device) => (
              <SelectItem
                key={device.device_id}
                value={`device:${device.device_id}`}
              >
                {device.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {scope.kind === "local"
        ? <LocalDashboard />
        : <GlobalDashboard scope={scope} devices={devices.data?.devices ?? []} />}

      <AccountStatusCards
        overview={account.data}
        settings={settings.data}
        balance={balance.data}
      />
    </div>
  )
}

function LocalDashboard() {
  const [range, setRange] = useState<RangeName>("24h")
  const { currency } = useCurrency()
  const { data, loading, error } = useOverview(range)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <RangeSelector value={range} onChange={setRange} />
      </div>

      <ErrorBanner error={error} />

      {loading || data === null
        ? <PageSkeleton rows={4} />
        : (
          <>
            <GlobalCards global={data.global} currency={currency} />
            <ProviderTable providers={data.providers} />
            <ErrorsSummary errors={data.errors} />
          </>
        )}
    </div>
  )
}

function AccountStatusCards({
  overview,
  settings,
  balance,
}: {
  overview: ReturnType<typeof useOverview>["data"]
  settings: SettingsResponse | null
  balance: DeepseekBalanceResponse | null
}) {
  return (
    <div className="flex flex-col gap-6">
      {settings?.exchangeRate === null && settings.currency === "cny" ? (
        <Alert variant="destructive">
          <AlertTitle>汇率不可用</AlertTitle>
          <AlertDescription>
            人民币显示需要汇率，当前没有可用汇率缓存，费用暂时按美元显示。
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-2">
        <WeeklyQuotaCard
          usedPercent={overview?.weeklyQuota?.usedPercent ?? null}
          resetsAt={overview?.weeklyQuota?.resetsAt ?? null}
          planType={overview?.weeklyQuota?.planType ?? null}
        />
        <DeepseekBalanceCard
          available={balance?.available ?? false}
          balances={balance?.balances ?? []}
        />
      </div>
    </div>
  )
}

function GlobalDashboard({
  scope,
  devices,
}: {
  scope: Extract<Scope, { kind: "all" } | { kind: "device" }>
  devices: GlobalDeviceRow[]
}) {
  const deviceId = scope.kind === "device" ? scope.deviceId : null
  const overview = useApi(
    (signal) => fetchGlobalOverview(deviceId, signal),
    [deviceId],
  )

  return (
    <div className="flex flex-col gap-6">
      <ErrorBanner error={overview.error} />

      {overview.loading || overview.data === null
        ? <PageSkeleton rows={4} />
        : (
          <>
            <GlobalTotalsCards totals={overview.data.totals} />
            <GlobalCostTable rows={overview.data.costsByCurrency} />
            <GlobalProviderTable rows={overview.data.providers} />
          </>
        )}

      {scope.kind === "all"
        ? <GlobalDeviceTable rows={devices} loading={devices.length === 0 && overview.loading} />
        : null}
    </div>
  )
}

function GlobalTotalsCards({ totals }: { totals: GlobalOverviewResponse["totals"] | null }) {
  if (totals === null) {
    return (
      <Alert>
        <AlertTitle>暂无数据</AlertTitle>
        <AlertDescription>中心库还没有任何设备上报记录</AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="设备数"
        value={totals.device_count.toLocaleString("zh-CN")}
        description="已上报设备"
      />
      <StatCard
        title="请求数"
        value={totals.request_count.toLocaleString("zh-CN")}
        description={`子代理 ${totals.subagent_count.toLocaleString("zh-CN")}`}
      />
      <StatCard
        title="总 Token"
        value={formatTokens(totals.total_tokens)}
        description={`输入 ${formatTokens(totals.input_tokens)} · 输出 ${formatTokens(totals.output_tokens)}`}
      />
      <StatCard
        title="最近上报"
        value={totals.last_recorded_at_ms === null ? "—" : formatTime(totals.last_recorded_at_ms)}
        description="中心最后一条记录"
      />
    </div>
  )
}

function GlobalCostTable({ rows }: { rows: GlobalCostRow[] }) {
  if (rows.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>费用（按币种）</CardTitle>
        <CardDescription>不同币种不合并，按中心库计价快照统计</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>币种</TableHead>
              <TableHead>已计价请求</TableHead>
              <TableHead>费用</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.currency}>
                <TableCell>{row.currency}</TableCell>
                <TableCell className="tabular-nums">
                  {row.request_count.toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatNanos(row.total_cost_nanos, row.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function GlobalProviderTable({ rows }: { rows: GlobalProviderRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>按提供商</CardTitle>
        <CardDescription>当前范围的累计请求与 Token</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>提供商</TableHead>
              <TableHead>请求数</TableHead>
              <TableHead>输入 Token</TableHead>
              <TableHead>输出 Token</TableHead>
              <TableHead>总 Token</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.provider ?? "unknown"}>
                <TableCell>{row.provider ?? "未知"}</TableCell>
                <TableCell className="tabular-nums">
                  {row.request_count.toLocaleString("zh-CN")}
                </TableCell>
                <TableCell className="tabular-nums">{formatTokens(row.input_tokens)}</TableCell>
                <TableCell className="tabular-nums">{formatTokens(row.output_tokens)}</TableCell>
                <TableCell className="tabular-nums">{formatTokens(row.total_tokens)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function GlobalDeviceTable({ rows, loading }: { rows: GlobalDeviceRow[]; loading: boolean }) {
  if (loading && rows.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>设备</CardTitle>
        <CardDescription>各设备首次与最后上报时间</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>设备</TableHead>
              <TableHead>首次上报</TableHead>
              <TableHead>最后上报</TableHead>
              <TableHead>请求数</TableHead>
              <TableHead>子代理数</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.device_id}>
                <TableCell className="font-medium">{row.display_name}</TableCell>
                <TableCell className="tabular-nums">{formatTime(row.first_seen_at_ms)}</TableCell>
                <TableCell className="tabular-nums">{formatTime(row.last_seen_at_ms)}</TableCell>
                <TableCell className="tabular-nums">{row.request_count.toLocaleString("zh-CN")}</TableCell>
                <TableCell className="tabular-nums">{row.subagent_count.toLocaleString("zh-CN")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function formatNanos(nanos: number | null, currency: string | null): string {
  const amount = Number(nanos ?? 0) / 1e9
  if (currency === "CNY") return `¥${amount.toFixed(4)}`
  if (currency === "USD") return `$${amount.toFixed(4)}`
  return `${amount.toFixed(4)} ${currency ?? ""}`.trim()
}
