import { useState, type ReactNode } from "react"
import { ActivityCalendar } from "react-activity-calendar"
import "react-activity-calendar/tooltips.css"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

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
import { useOfficialAccountSources } from "@/hooks/use-official-account-sources"
import type { AccountSnapshotFreshness } from "@/hooks/use-official-account-sources"
import { useOverview } from "@/hooks/use-overview"
import {
  fetchGlobalDaily,
  fetchGlobalDevices,
  fetchGlobalOverview,
} from "@/lib/api"
import { formatTime, formatTokens } from "@/lib/format"
import type { DisplayCurrency } from "@/lib/format"
import { toStackedUsageTrend } from "@/lib/trend"
import { resolveDisplayCost } from "@/lib/cost"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import type {
  DeepseekBalanceResponse,
  GlobalCostRow,
  GlobalDailyRow,
  GlobalDeviceRow,
  GlobalOverviewResponse,
  GlobalProviderRow,
  OpencodeGoUsageResponse,
  OverviewResponse,
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
  const [range, setRange] = useState<RangeName>("24h")
  const devices = useApi(
    (signal) => scope.kind === "local"
      ? Promise.resolve({ devices: [] })
      : fetchGlobalDevices(signal),
    [scope.kind],
  )
  const account = useOverview(scope.kind === "local" ? range : "24h")
  const officialAccounts = useOfficialAccountSources()
  const { currency, settings } = useCurrency()
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
        ? <LocalDashboard range={range} onRangeChange={setRange} data={account.data} loading={account.loading} error={account.error} />
        : <GlobalDashboard scope={scope} devices={devices.data?.devices ?? []} currency={currency ?? settings?.currency ?? "usd"} exchangeRate={settings?.exchangeRate?.usdToCny ?? null} />}

      {scope.kind === "local" ? (
        <AccountStatusCards
          overview={account.data}
          settings={settings}
          balance={officialAccounts.data?.deepseek ?? null}
          opencodeGoUsage={officialAccounts.data?.opencodeGo ?? null}
          freshness={officialAccounts.data?.freshness ?? { deepseek: "missing", opencodeGo: "missing" }}
        />
      ) : null}
    </div>
  )
}

function LocalDashboard({
  range,
  onRangeChange,
  data,
  loading,
  error,
}: {
  range: RangeName
  onRangeChange: (range: RangeName) => void
  data: OverviewResponse | null
  loading: boolean
  error: string | null
}) {
  const { currency } = useCurrency()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">本地模块</h2>
        <p className="text-sm text-muted-foreground">本机指标、请求错误和官方账户额度。</p>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <RangeSelector value={range} onChange={onRangeChange} />
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
  freshness,
}: {
  overview: ReturnType<typeof useOverview>["data"]
  settings: ReturnType<typeof useCurrency>["settings"]
  balance: DeepseekBalanceResponse | null
  opencodeGoUsage: OpencodeGoUsageResponse | null
  freshness: { deepseek: AccountSnapshotFreshness; opencodeGo: AccountSnapshotFreshness }
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
      <div>
        <h2 className="text-lg font-semibold">本地账户与额度</h2>
        <p className="text-sm text-muted-foreground">数据来自本机 Gateway 的账户快照；全局模块不展示本机账户。</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <WeeklyQuotaCard
          usedPercent={overview?.weeklyQuota?.usedPercent ?? null}
          resetsAt={overview?.weeklyQuota?.resetsAt ?? null}
          planType={overview?.weeklyQuota?.planType ?? null}
        />
        <div className="flex flex-col gap-2">
          <FreshnessNotice provider="DS" status={freshness.deepseek} />
          <DeepseekBalanceCard
            available={balance?.available ?? false}
            balances={balance?.balances ?? []}
          />
        </div>
        <div className="flex flex-col gap-2">
          <FreshnessNotice provider="OCG" status={freshness.opencodeGo} />
          <OpencodeGoUsageCard
            accounts={opencodeGoUsage?.accounts ?? []}
          />
        </div>
      </div>
    </div>
  )
}

function FreshnessNotice({
  provider,
  status,
}: {
  provider: "DS" | "OCG"
  status: AccountSnapshotFreshness
}) {
  if (status === "fresh") return null
  return (
    <Alert>
      <AlertTitle>{provider} 账户快照需要刷新</AlertTitle>
      <AlertDescription>
        {status === "missing" ? "尚未获取到账户快照。" : "本地快照已超过 15 分钟。"}
        请在对应渠道执行 /usage 或 /limits 后刷新本页面。
      </AlertDescription>
    </Alert>
  )
}

function GlobalDashboard({
  scope,
  devices,
  currency,
  exchangeRate,
}: {
  scope: Extract<Scope, { kind: "all" } | { kind: "device" }>
  devices: GlobalDeviceRow[]
  currency: DisplayCurrency
  exchangeRate: number | null
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
      <div>
        <h2 className="text-lg font-semibold">全局模块</h2>
        <p className="text-sm text-muted-foreground">数据中心累计视图：核心指标、用量走势、设备明细、费用和 Provider。</p>
      </div>
      <ErrorBanner error={overview.error} />

      {overview.loading || overview.data === null
        ? <PageSkeleton rows={4} />
        : (
          <>
            <DashboardSection title="核心指标" description="当前范围内所有设备的累计数据">
              <GlobalTotalsCards totals={overview.data.totals} costs={overview.data.costsByCurrency} currency={currency} exchangeRate={exchangeRate} />
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
                <GlobalDeviceTable rows={devices} loading={devices.length === 0 && overview.loading} currency={currency} exchangeRate={exchangeRate} />
              </DashboardSection>
            ) : null}

            <DashboardSection title="费用与 Provider" description="计价费用和 Provider 分布分开查看">
              <GlobalProviderTable rows={overview.data.providers} />
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

function GlobalTotalsCards({
  totals,
  costs,
  currency,
  exchangeRate,
}: {
  totals: GlobalOverviewResponse["totals"] | null
  costs: GlobalCostRow[]
  currency: DisplayCurrency
  exchangeRate: number | null
}) {
  if (totals === null) {
    return (
      <Alert>
        <AlertTitle>暂无数据</AlertTitle>
        <AlertDescription>中心库还没有任何设备上报记录</AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
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
      <CostStatCard costs={costs} currency={currency} exchangeRate={exchangeRate} />
      <StatCard
        title="最近上报"
        value={totals.last_recorded_at_ms === null ? "—" : formatTime(totals.last_recorded_at_ms)}
        description="中心最后一条记录"
      />
    </div>
  )
}

function CostStatCard({
  costs,
  currency,
  exchangeRate,
}: {
  costs: GlobalCostRow[]
  currency: DisplayCurrency
  exchangeRate: number | null
}) {
  const displayCost = resolveDisplayCost(costs, currency, exchangeRate)
  const primary = displayCost ? formatNanos(displayCost.primaryNanos, displayCost.primaryCurrency, 2) : formatNanos(null, currency === "cny" ? "CNY" : "USD", 2)
  const equivalent = displayCost?.equivalentNanos === null || displayCost?.equivalentNanos === undefined
    ? "—"
    : formatNanos(displayCost.equivalentNanos, displayCost.equivalentCurrency, 2)
  const requestCount = displayCost?.requestCount ?? 0
  return (
    <StatCard
      title="费用"
      value={primary}
      description={`${equivalent} · ${requestCount.toLocaleString("zh-CN")} 个已计价请求`}
    />
  )
}

function GlobalTrendCard({ rows, loading }: { rows: GlobalDailyRow[]; loading: boolean }) {
  const [timeRange, setTimeRange] = useState("30d")
  const daysToSubtract = timeRange === "7d" ? 7 : timeRange === "90d" ? 90 : 30
  const latestDay = rows.reduce((latest, row) => row.day > latest ? row.day : latest, "")
  const referenceDate = latestDay ? new Date(`${latestDay}T00:00:00Z`) : new Date()
  const cutoff = new Date(referenceDate.getTime() - (daysToSubtract - 1) * 86_400_000)
  const cutoffKey = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}-${String(cutoff.getUTCDate()).padStart(2, "0")}`
  const data = rows
    .toSorted((a, b) => a.day.localeCompare(b.day))
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
  const chartData = stackedData.map((row, index) => ({
    ...row,
    totalTokens: data[index]?.totalTokens ?? 0,
    outputTokens: (row.nonReasoningOutputTokens ?? 0) + (row.reasoningOutputTokens ?? 0),
  }))
  const chartConfig: ChartConfig = {
    totalTokens: { label: "日总计", color: "var(--chart-1)" },
    uncachedInputTokens: { label: "未缓存输入", color: "var(--chart-2)" },
    cachedInputTokens: { label: "缓存输入", color: "var(--chart-3)" },
    outputTokens: { label: "输出", color: "var(--chart-4)" },
  }
  return (
    <Card className="h-[340px]">
      <CardHeader>
        <div className="flex items-center gap-2">
          <div className="grid flex-1 gap-1">
            <CardTitle>用量趋势</CardTitle>
            <CardDescription>最近 {daysToSubtract} 天，输入按缓存拆分；输出独立显示</CardDescription>
          </div>
          <Select value={timeRange} onValueChange={setTimeRange}>
            <SelectTrigger className="hidden w-[140px] rounded-lg sm:flex" aria-label="选择趋势时间范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectItem value="90d" className="rounded-lg">最近 90 天</SelectItem>
              <SelectItem value="30d" className="rounded-lg">最近 30 天</SelectItem>
              <SelectItem value="7d" className="rounded-lg">最近 7 天</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading && data.length === 0 ? (
          <PageSkeleton rows={3} />
        ) : data.length === 0 ? (
          <p className="text-sm text-muted-foreground">当前范围最近 90 天没有记录</p>
        ) : (
          <ChartContainer config={chartConfig} className="h-[230px] w-full">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fillUncachedInput" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-uncachedInputTokens)" stopOpacity={0.5} /><stop offset="95%" stopColor="var(--color-uncachedInputTokens)" stopOpacity={0.05} /></linearGradient>
                <linearGradient id="fillCachedInput" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="var(--color-cachedInputTokens)" stopOpacity={0.5} /><stop offset="95%" stopColor="var(--color-cachedInputTokens)" stopOpacity={0.05} /></linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} />
              <YAxis yAxisId="tokens" tickLine={false} axisLine={false} tickFormatter={formatTokens} width={52} />
              <YAxis yAxisId="output" orientation="right" tickLine={false} axisLine={false} tickFormatter={formatTokens} width={52} />
              <ChartTooltip content={<ChartTooltipContent valueFormatter={formatTokens} />} />
              <Area yAxisId="tokens" dataKey="uncachedInputTokens" type="monotone" stackId="input" stroke="var(--color-uncachedInputTokens)" fill="url(#fillUncachedInput)" />
              <Area yAxisId="tokens" dataKey="cachedInputTokens" type="monotone" stackId="input" stroke="var(--color-cachedInputTokens)" fill="url(#fillCachedInput)" />
              <Area yAxisId="tokens" dataKey="totalTokens" type="monotone" stroke="var(--color-totalTokens)" fill="none" strokeWidth={2} />
              <Area yAxisId="output" dataKey="outputTokens" type="monotone" stroke="var(--color-outputTokens)" fill="none" strokeWidth={2} />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

export function GlobalHeatmapCard({ rows, loading }: { rows: GlobalDailyRow[]; loading: boolean }) {
  const byDay = new Map(rows.map((row) => [row.day, row.total_tokens]))
  const days = 90
  const now = new Date()
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
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
                  <TableCell>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="font-medium hover:underline">{label}</button>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-h-[60vh] max-w-none overflow-y-auto border border-border bg-card p-0 text-card-foreground shadow-lg">
                        <div className="max-w-[720px] overflow-x-auto p-3">
                          <p className="mb-2 text-xs font-medium text-card-foreground">按模型统计</p>
                          <Table className="min-w-[620px]">
                            <TableHeader><TableRow><TableHead>模型</TableHead><TableHead>请求数</TableHead><TableHead>输入 Token</TableHead><TableHead>输出 Token</TableHead><TableHead>总 Token</TableHead></TableRow></TableHeader>
                            <TableBody>
                              {(row.models ?? []).length === 0 ? <TableRow><TableCell colSpan={5}>暂无模型数据</TableCell></TableRow> : (row.models ?? []).map((model) => (
                                <TableRow key={model.model ?? "unknown"}>
                                  <TableCell>{model.model ?? "未知模型"}</TableCell>
                                  <TableCell className="tabular-nums">{model.request_count.toLocaleString("zh-CN")}</TableCell>
                                  <TableCell className="tabular-nums">{formatTokens(model.input_tokens)}</TableCell>
                                  <TableCell className="tabular-nums">{formatTokens(model.output_tokens)}</TableCell>
                                  <TableCell className="tabular-nums">{formatTokens(model.total_tokens)}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  </TableCell>
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

function GlobalDeviceTable({ rows, loading, currency, exchangeRate }: { rows: GlobalDeviceRow[]; loading: boolean; currency: DisplayCurrency; exchangeRate: number | null }) {
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
              <TableHead>总 Token</TableHead>
              <TableHead>费用</TableHead>
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
                <TableCell className="tabular-nums">{formatTokens(row.total_tokens)}</TableCell>
                <TableCell className="tabular-nums">{formatDeviceCost(row.costs_by_currency, currency, exchangeRate)}</TableCell>
                <TableCell className="tabular-nums">{row.subagent_count.toLocaleString("zh-CN")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function formatDeviceCost(costs: GlobalCostRow[], currency: DisplayCurrency, exchangeRate: number | null): string {
  const displayCost = resolveDisplayCost(costs, currency, exchangeRate)
  if (!displayCost) return "—"
  const primary = formatNanos(displayCost.primaryNanos, displayCost.primaryCurrency, 2)
  const equivalent = displayCost.equivalentNanos === null
    ? null
    : formatNanos(displayCost.equivalentNanos, displayCost.equivalentCurrency, 2)
  return equivalent ? `${primary} · ${equivalent}` : primary
}

function formatNanos(nanos: number | null, currency: string | null, fractionDigits = 4): string {
  const amount = Number(nanos ?? 0) / 1e9
  const formatted = amount.toLocaleString("zh-CN", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })
  if (currency === "CNY") return `¥${formatted}`
  if (currency === "USD") return `$${formatted}`
  return `${formatted} ${currency ?? ""}`.trim()
}
