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
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
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
  OpencodeGoUsageCard,
  ProviderTable,
  WeeklyQuotaCard,
} from "@/components/overview/overview-sections"
import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { useOverview } from "@/hooks/use-overview"
import {
  fetchDeepseekBalance,
  fetchGlobalDaily,
  fetchGlobalDevices,
  fetchGlobalOverview,
  fetchOpencodeGoUsage,
  fetchSettings,
} from "@/lib/api"
import { formatTime, formatTokens } from "@/lib/format"
import type {
  DeepseekBalanceResponse,
  GlobalCostRow,
  GlobalDailyRow,
  GlobalDeviceRow,
  GlobalOverviewResponse,
  GlobalProviderRow,
  OpencodeGoUsageResponse,
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
  const opencodeGoUsage = useApi((signal) => fetchOpencodeGoUsage(signal), [])
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
        opencodeGoUsage={opencodeGoUsage.data}
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
  opencodeGoUsage,
}: {
  overview: ReturnType<typeof useOverview>["data"]
  settings: SettingsResponse | null
  balance: DeepseekBalanceResponse | null
  opencodeGoUsage: OpencodeGoUsageResponse | null
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
        <OpencodeGoUsageCard
          available={opencodeGoUsage?.available ?? false}
          windows={opencodeGoUsage?.windows ?? []}
          modelUsage={opencodeGoUsage?.modelUsage ?? []}
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
  const daily = useApi(
    (signal) => fetchGlobalDaily(deviceId, 90, signal),
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
            <GlobalTrendCard rows={daily.data?.daily ?? []} loading={daily.loading} />
            <GlobalHeatmapCard rows={daily.data?.daily ?? []} loading={daily.loading} />
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

const HEATMAP_COLORS = ["#ebedf0", "#a7f3d0", "#6ee7b7", "#34d399", "#10b981"]
const TREND_COLORS = {
  input: "#38bdf8",
  cached: "#14b8a6",
  output: "#a78bfa",
  reasoning: "#fb7185",
}

function GlobalTrendCard({ rows, loading }: { rows: GlobalDailyRow[]; loading: boolean }) {
  const cutoff = new Date(Date.now() - 29 * 86_400_000)
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`
  const data = rows
    .filter((row) => row.day >= cutoffKey)
    .map((row) => ({
      day: row.day.slice(5),
      input: row.input_tokens,
      cached: row.cached_input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_output_tokens,
    }))
  return (
    <Card>
      <CardHeader>
        <CardTitle>用量趋势</CardTitle>
        <CardDescription>最近 30 天，按输入 / 缓存 / 输出 / 推理堆叠</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && data.length === 0 ? (
          <PageSkeleton rows={3} />
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前范围最近 90 天没有记录</p>
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={48}
                  tickFormatter={(value: number) => formatTokens(value)}
                />
                <Tooltip
                  formatter={(value, name) => {
                    const labels: Record<string, string> = {
                      input: "输入",
                      cached: "缓存输入",
                      output: "输出",
                      reasoning: "推理输出",
                    }
                    return [formatTokens(Number(value ?? 0)), labels[String(name)] ?? String(name)]
                  }}
                />
                <Bar dataKey="reasoning" stackId="tokens" fill={TREND_COLORS.reasoning} />
                <Bar dataKey="cached" stackId="tokens" fill={TREND_COLORS.cached} />
                <Bar dataKey="output" stackId="tokens" fill={TREND_COLORS.output} />
                <Bar dataKey="input" stackId="tokens" fill={TREND_COLORS.input} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function GlobalHeatmapCard({ rows, loading }: { rows: GlobalDailyRow[]; loading: boolean }) {
  const byDay = new Map(rows.map((row) => [row.day, row.total_tokens]))
  const days = 90
  const today = new Date()
  const cells: Array<{ date: string; value: number }> = []
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today.getTime() - index * 86_400_000)
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
    cells.push({ date: key, value: byDay.get(key) ?? 0 })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>活动热力图</CardTitle>
        <CardDescription>最近 90 天每日 Token 量</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && rows.length === 0 ? (
          <PageSkeleton rows={3} />
        ) : (
          <div className="overflow-x-auto pb-1">
            <div
              className="grid w-max gap-[3px]"
              style={{
                gridAutoFlow: "column",
                gridTemplateRows: "repeat(7, 12px)",
              }}
            >
              {cells.map((cell) => (
                <div
                  key={cell.date}
                  title={`${cell.date} · ${formatTokens(cell.value)}`}
                  className="rounded-[3px]"
                  style={{ backgroundColor: heatColor(cell.value), width: 12, height: 12 }}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function heatColor(value: number): string {
  if (value <= 0) return HEATMAP_COLORS[0]!
  if (value < 1_000_000) return HEATMAP_COLORS[1]!
  if (value < 10_000_000) return HEATMAP_COLORS[2]!
  if (value < 50_000_000) return HEATMAP_COLORS[3]!
  return HEATMAP_COLORS[4]!
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
