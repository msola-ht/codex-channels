import { useState, type ReactNode } from "react"
import { ActivityCalendar } from "react-activity-calendar"
import "react-activity-calendar/tooltips.css"
import ReactECharts from "echarts-for-react"
import type { EChartsOption } from "echarts"

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
  fetchGlobalQuota,
  fetchOpencodeGoUsage,
  fetchSettings,
} from "@/lib/api"
import { formatTime, formatTokens } from "@/lib/format"
import { positionTrendTooltip, toStackedUsageTrend } from "@/lib/trend"
import type {
  DeepseekBalanceResponse,
  GlobalCostRow,
  GlobalDailyRow,
  GlobalDeviceRow,
  GlobalOverviewResponse,
  GlobalQuotaResponse,
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
          accounts={opencodeGoUsage?.accounts ?? []}
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
  const quota = useApi(
    (signal) => fetchGlobalQuota(365, deviceId, signal),
    [deviceId],
  )

  return (
    <div className="flex flex-col gap-6">
      <ErrorBanner error={overview.error} />

      {overview.loading || overview.data === null
        ? <PageSkeleton rows={4} />
        : (
          <>
            <DashboardSection title="核心指标" description="当前范围内所有设备的累计数据">
              <GlobalTotalsCards totals={overview.data.totals} />
            </DashboardSection>

            <DashboardSection title="用量走势" description="从趋势和日历两个维度查看使用节奏">
              <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
                <div className="min-w-0 xl:self-center">
                  <GlobalHeatmapCard rows={daily.data?.daily ?? []} loading={daily.loading} />
                </div>
                <div className="min-w-0 xl:self-center">
                  <GlobalTrendCard rows={daily.data?.daily ?? []} loading={daily.loading} />
                </div>
              </div>
            </DashboardSection>

            {scope.kind === "all" ? (
              <DashboardSection title="设备明细" description="确认哪些设备正在贡献数据，以及最近上报时间">
                <GlobalDeviceTable rows={devices} loading={devices.length === 0 && overview.loading} />
              </DashboardSection>
            ) : null}

            <DashboardSection title="额度与费用" description="渠道额度窗口、计价币种和 Provider 分布分开查看">
              <GlobalQuotaCard quota={quota.data} loading={quota.loading} />
              <div className="grid gap-6 xl:grid-cols-2">
                <GlobalCostTable rows={overview.data.costsByCurrency} />
                <GlobalProviderTable rows={overview.data.providers} />
              </div>
            </DashboardSection>
          </>
        )}
    </div>
  )
}

function DashboardSection({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-col gap-6">{children}</div>
    </section>
  )
}

function GlobalQuotaCard({
  quota,
  loading,
}: {
  quota: GlobalQuotaResponse | null
  loading: boolean
}) {
  if (loading && quota === null) return <PageSkeleton rows={2} />
  if (quota === null || quota.periods.length === 0) {
    return <Alert><AlertTitle>暂无额度周期</AlertTitle><AlertDescription>中心库尚未收集到带重置时间的额度快照</AlertDescription></Alert>
  }
  const groups = new Map<string, GlobalQuotaResponse["periods"]>()
  for (const period of quota.periods) {
    const key = `${period.provider}\u0000${period.windowId}`
    const group = groups.get(key) ?? []
    group.push(period)
    groups.set(key, group)
  }
  const current = [...groups.values()]
    .map((periods) => [...periods].sort((a, b) => b.resetsAt - a.resetsAt)[0]!)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.windowId.localeCompare(b.windowId))
  const history = [...groups.entries()]
    .map(([key, periods]) => ({
      key,
      periods: [...periods].sort((a, b) => b.resetsAt - a.resetsAt).slice(1),
    }))
    .filter((group) => group.periods.length > 0)
  return (
    <Card>
      <CardHeader>
        <CardTitle>渠道额度估算</CardTitle>
        <CardDescription>最近 {quota.days} 天 · 按渠道和额度窗口汇总，默认展示最新周期</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {current.map((period) => <QuotaPeriodCard key={`${period.provider}-${period.windowId}`} period={period} />)}
        </div>
        {history.length === 0 ? null : (
          <details className="group rounded-lg border bg-muted/20 px-3">
            <summary className="cursor-pointer list-none py-3 text-sm font-medium">
              历史周期
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {history.reduce((count, group) => count + group.periods.length, 0)} 个
              </span>
              <span className="float-right text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <div className="overflow-x-auto pb-3">
              <Table className="min-w-[900px]">
                <TableHeader><TableRow>
                  <TableHead>渠道 / 额度窗口</TableHead><TableHead>周期开始</TableHead><TableHead>周期结束</TableHead><TableHead>周期时长</TableHead><TableHead>参与设备</TableHead>
                  <TableHead>已使用 Token</TableHead><TableHead>最新使用率</TableHead><TableHead>推算周期容量</TableHead>
                </TableRow></TableHeader>
                <TableBody>{history.flatMap((group) => group.periods.map((period) => (
                  <TableRow key={`${period.provider}-${period.windowId}-${period.resetsAt}`}>
                    <TableCell>{period.providerDisplayName?.trim() || period.provider} · {period.windowId}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatTime(period.periodStartAtMs)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatTime(period.periodEndAtMs)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{formatQuotaSpan(period.periodStartAtMs, period.periodEndAtMs)}</TableCell>
                    <TableCell>{period.deviceCount}</TableCell>
                    <TableCell>{formatTokens(period.totalTokens)}</TableCell>
                    <TableCell>{formatQuotaPercent(period.latestUsedPercentMillionths)}</TableCell>
                    <TableCell>{period.estimatedTotalTokens === null ? "未提供" : formatTokens(period.estimatedTotalTokens)}</TableCell>
                  </TableRow>
                )))}</TableBody>
              </Table>
            </div>
          </details>
        )}
      </CardContent>
    </Card>
  )
}

function QuotaPeriodCard({ period }: { period: GlobalQuotaResponse["periods"][number] }) {
  const hasPercent = period.latestUsedPercentMillionths !== null
  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">渠道：{period.providerDisplayName?.trim() || period.provider}</p>
          <p className="text-xs text-muted-foreground">额度窗口：{period.windowId}</p>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {period.deviceCount} 台设备
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
        <div><p className="text-xs text-muted-foreground">{hasPercent ? "最新使用率" : "已使用 Token"}</p><p className="mt-1 text-lg font-semibold tabular-nums">{hasPercent ? formatQuotaPercent(period.latestUsedPercentMillionths) : formatTokens(period.totalTokens)}</p></div>
        <div><p className="text-xs text-muted-foreground">{hasPercent ? "已使用 Token" : "额度百分比"}</p><p className="mt-1 text-lg font-semibold tabular-nums">{hasPercent ? formatTokens(period.totalTokens) : "未提供"}</p></div>
      </div>
      <div className="mt-3 overflow-x-auto border-t pt-3 text-xs text-muted-foreground">
        <div className="flex min-w-max items-center gap-2 tabular-nums">
          <span title="周期开始">{formatQuotaTimelineTime(period.periodStartAtMs)}</span>
          <span className="flex items-center gap-1" aria-hidden="true">
            <i className="size-1.5 rounded-full bg-primary" />
            <i className="h-px w-4 bg-border" />
            <span className="rounded-full border bg-muted px-2 py-0.5 font-medium text-foreground">{formatQuotaSpan(period.periodStartAtMs, period.periodEndAtMs)}</span>
            <i className="h-px w-4 bg-border" />
            <i className="size-1.5 rounded-full bg-primary" />
          </span>
          <span title="周期结束">{formatQuotaTimelineTime(period.periodEndAtMs)}</span>
          {hasPercent && period.estimatedTotalTokens !== null ? <span className="ml-1 rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">估算 {formatTokens(period.estimatedTotalTokens)}</span> : null}
        </div>
      </div>
    </div>
  )
}

function formatQuotaPercent(value: number | null): string {
  return value === null ? "未提供" : `${(value / 1_000_000).toFixed(2)}%`
}

function formatQuotaSpan(startAtMs: number | null, endAtMs: number): string {
  if (startAtMs === null || endAtMs < startAtMs) return "未知"
  const minutes = Math.max(0, Math.round((endAtMs - startAtMs) / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = minutes / 60
  if (hours < 24) return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`
  const days = hours / 24
  return `${Number.isInteger(days) ? days : days.toFixed(1)} 天`
}

function formatQuotaTimelineTime(value: number | null): string {
  if (value === null) return "未知"
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
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

const TREND_COLORS = {
  total: "#fbbf24",
  input: "#38bdf8",
  cached: "#14b8a6",
  output: "#a78bfa",
}

function GlobalTrendCard({ rows, loading }: { rows: GlobalDailyRow[]; loading: boolean }) {
  const cutoff = new Date(Date.now() - 29 * 86_400_000)
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`
  const data = rows
    .filter((row) => row.day >= cutoffKey)
    .map((row) => ({
      day: row.day,
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      outputTokens: row.output_tokens,
      reasoningOutputTokens: row.reasoning_output_tokens,
      totalTokens: row.total_tokens,
    }))
  const stackedData = toStackedUsageTrend(data)
  const chartOption: EChartsOption = {
    animation: false,
    grid: { top: 8, right: 56, bottom: 42, left: 56 },
    legend: { bottom: 0, right: 0, textStyle: { color: "#a1a1aa" }, itemWidth: 12, itemHeight: 8 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", snap: true },
      confine: true,
      position: (point, _params, _dom, _rect, size) => positionTrendTooltip(
        point,
        size.contentSize,
        size.viewSize,
      ),
      backgroundColor: "#18181b",
      borderColor: "#3f3f46",
      textStyle: { color: "#fafafa" },
      formatter: (params) => {
        const items = Array.isArray(params) ? params : [params]
        const first = items[0] as (typeof items)[number] & { axisValue?: unknown }
        const day = String(first?.axisValue ?? "")
        const index = Number(first?.dataIndex ?? 0)
        const split = stackedData[index]
        const total = Number(first?.value ?? 0)
        const markerFor = (seriesName: string) =>
          items.find((item) => item.seriesName === seriesName)?.marker ?? ""
        return [
          `<div style="margin-bottom:6px;font-weight:600">${day}</div>`,
          `<div style="line-height:1.8">${markerFor("日总计")}日总计：${formatTokens(total)}</div>`,
          `<div style="color:#a1a1aa;line-height:1.8">${markerFor("未缓存输入")}未缓存输入：${formatTokens(split?.uncachedInputTokens ?? 0)}</div>`,
          `<div style="color:#a1a1aa;line-height:1.8">${markerFor("缓存输入")}缓存输入：${formatTokens(split?.cachedInputTokens ?? 0)}</div>`,
          `<div style="color:#a1a1aa;line-height:1.8">${markerFor("输出")}输出：${formatTokens((split?.nonReasoningOutputTokens ?? 0) + (split?.reasoningOutputTokens ?? 0))}</div>`,
        ].join("")
      },
    },
    xAxis: { type: "category", boundaryGap: false, data: stackedData.map((row) => row.day), axisLine: { lineStyle: { color: "#3f3f46" } }, axisLabel: { color: "#a1a1aa", interval: "auto" } },
    yAxis: [
      { type: "value", axisLabel: { color: "#a1a1aa", formatter: (value: number) => formatTokens(value) }, splitLine: { lineStyle: { color: "#27272a" } } },
      { type: "value", position: "right", axisLabel: { color: "#a1a1aa", formatter: (value: number) => formatTokens(value) }, splitLine: { show: false } },
    ],
    series: [
      { name: "日总计", type: "line", symbol: "none", lineStyle: { width: 2 }, itemStyle: { color: TREND_COLORS.total }, data: data.map((row) => row.totalTokens), z: 4 },
      { name: "未缓存输入", type: "line", stack: "input", symbol: "none", areaStyle: { opacity: 0.32 }, lineStyle: { width: 1.5 }, itemStyle: { color: TREND_COLORS.input }, data: stackedData.map((row) => row.uncachedInputTokens) },
      { name: "缓存输入", type: "line", stack: "input", symbol: "none", areaStyle: { opacity: 0.32 }, lineStyle: { width: 1.5 }, itemStyle: { color: TREND_COLORS.cached }, data: stackedData.map((row) => row.cachedInputTokens) },
      { name: "输出", type: "line", yAxisIndex: 1, symbol: "circle", symbolSize: 4, lineStyle: { width: 2 }, itemStyle: { color: TREND_COLORS.output }, data: stackedData.map((row) => row.nonReasoningOutputTokens + row.reasoningOutputTokens), z: 5 },
    ],
  }
  return (
    <Card className="h-[340px]">
      <CardHeader>
        <CardTitle>用量趋势</CardTitle>
          <CardDescription>最近 30 天，输入按缓存拆分；输出使用右侧独立刻度</CardDescription>
      </CardHeader>
      <CardContent>
        {loading && data.length === 0 ? (
          <PageSkeleton rows={3} />
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前范围最近 90 天没有记录</p>
        ) : (
          <ReactECharts option={chartOption} style={{ height: 230, width: "100%" }} notMerge lazyUpdate />
        )}
      </CardContent>
    </Card>
  )
}

export function GlobalHeatmapCard({ rows, loading }: { rows: GlobalDailyRow[]; loading: boolean }) {
  const byDay = new Map(rows.map((row) => [row.day, row.total_tokens]))
  const days = 90
  const today = new Date()
  const cells: Array<{ date: string; count: number; level: number }> = []
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(today.getTime() - index * 86_400_000)
    const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
    const count = byDay.get(key) ?? 0
    cells.push({ date: key, count, level: 0 })
  }
  const positive = cells.map((cell) => cell.count).filter((count) => count > 0).sort((a, b) => a - b)
  const thresholds = positive.length === 0
    ? [0, 0, 0]
    : [positive[Math.floor(positive.length * 0.25)]!, positive[Math.floor(positive.length * 0.5)]!, positive[Math.floor(positive.length * 0.75)]!]
  for (const cell of cells) {
    cell.level = cell.count <= 0 ? 0 : cell.count <= thresholds[0]! ? 1 : cell.count <= thresholds[1]! ? 2 : cell.count <= thresholds[2]! ? 3 : 4
  }
  const total = cells.reduce((sum, cell) => sum + cell.count, 0)
  const activeDays = cells.filter((cell) => cell.count > 0).length
  return (
    <Card className="h-[340px]">
      <CardHeader>
        <CardTitle>活动热力图</CardTitle>
        <CardDescription>最近 90 天每日 Token 量</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col justify-center">
        {loading && rows.length === 0 ? (
          <PageSkeleton rows={3} />
        ) : (
          <>
          <div className="flex justify-center overflow-x-auto pb-1">
            <ActivityCalendar
              data={cells}
              blockSize={18}
              blockMargin={5}
              blockRadius={3}
              weekStart={1}
              showWeekdayLabels={["mon", "wed", "fri"]}
              style={{ width: "100%" }}
              showTotalCount={false}
              colorScheme="dark"
              theme={{
                light: ["#f1f5f9", "#bbf7d0", "#4ade80", "#16a34a", "#15803d"],
                dark: ["#202124", "#123b2a", "#17663f", "#1f9d63", "#35d07f"],
              }}
              labels={{
                months: ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"],
                weekdays: ["日", "一", "二", "三", "四", "五", "六"],
                legend: { less: "少", more: "多" },
              }}
              tooltips={{
                activity: { text: (activity) => `${activity.date} · ${formatTokens(activity.count)} Token` },
              }}
            />
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">最近 90 天共 {formatTokens(total)} Token · 活跃 {activeDays} 天</p>
          </>
        )}
      </CardContent>
    </Card>
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
        <div className="overflow-x-auto">
          <Table className="min-w-[560px]">
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
        </div>
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
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
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
            {rows.map((row) => {
              const label = row.provider_display_name?.trim() || row.provider || "未知"
              const key = [
                row.provider ?? "unknown",
                row.provider_display_name ?? "",
                row.provider_email ?? "",
                row.provider_phone ?? "",
              ].join("\u0000")
              return (
                <TableRow key={key}>
                  <TableCell>{label}</TableCell>
                  <TableCell className="tabular-nums">
                    {row.request_count.toLocaleString("zh-CN")}
                  </TableCell>
                  <TableCell className="tabular-nums">{formatTokens(row.input_tokens)}</TableCell>
                  <TableCell className="tabular-nums">{formatTokens(row.output_tokens)}</TableCell>
                  <TableCell className="tabular-nums">{formatTokens(row.total_tokens)}</TableCell>
                </TableRow>
              )
            })}
          </TableBody>
          </Table>
        </div>
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
