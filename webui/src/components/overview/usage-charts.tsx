import { useTheme } from "next-themes"
import { ActivityCalendar } from "react-activity-calendar"
import "react-activity-calendar/tooltips.css"
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { formatTokens } from "@/lib/format"
import { toUsageTrend } from "@/lib/trend"
import type { DailyUsageRow, Range, RangeName } from "@/lib/types"

const dayMs = 86_400_000
const rangeLabels: Record<RangeName, string> = {
  today: "今天",
  yesterday: "昨天",
  "this-week": "本周",
  "last-week": "上周",
  "this-month": "本月",
  "last-month": "上月",
  "24h": "最近 24 小时",
  "7d": "最近 7 天",
  "30d": "最近 30 天",
  "90d": "最近 90 天",
  "365d": "最近 365 天",
  all: "全部历史",
}

export function UsageCharts({
  trendRows,
  trendRange,
  heatmapRows,
  heatmapEndAtMs,
  heatmapLoading,
  error,
}: {
  trendRows: DailyUsageRow[]
  trendRange: Range
  heatmapRows: DailyUsageRow[]
  heatmapEndAtMs: number
  heatmapLoading: boolean
  error: string | null
}) {
  const filledTrendRows = fillDailyRange(trendRows, trendRange)
  const filledHeatmapRows = heatmapLoading && heatmapRows.length === 0
    ? []
    : fillRecentDays(heatmapRows, heatmapEndAtMs, 90)
  const rangeLabel = rangeLabels[trendRange.name]
  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner error={error} />
      <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        <ActivityHeatmapCard rows={filledHeatmapRows} loading={heatmapLoading} />
        <UsageTrendCard rows={filledTrendRows} rangeLabel={rangeLabel} />
      </div>
    </div>
  )
}

function UsageTrendCard({
  rows,
  rangeLabel,
}: {
  rows: DailyUsageRow[]
  rangeLabel: string
}) {
  const data = toUsageTrend(rows)
  const hasData = rows.some((row) => row.requestCount > 0)
  const chartConfig: ChartConfig = {
    inputTokens: { label: "输入", color: "var(--chart-1)" },
    cachedInputTokens: { label: "缓存", color: "var(--chart-2)" },
    outputTokens: { label: "输出", color: "var(--chart-3)" },
  }

  return (
    <Card className="h-[340px]">
      <CardHeader>
        <CardTitle>用量趋势</CardTitle>
        <CardDescription>{rangeLabel} Token 变化</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <Empty className="h-[230px] p-4"><EmptyHeader><EmptyTitle>{rangeLabel}没有记录</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <ChartContainer config={chartConfig} className="h-[230px] w-full">
            <AreaChart accessibilityLayer data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fillInput" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-inputTokens)" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="var(--color-inputTokens)" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="fillCachedInput" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-cachedInputTokens)" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="var(--color-cachedInputTokens)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(day) => String(day).slice(5)} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={formatTokens} width={52} />
              <ChartTooltip content={<ChartTooltipContent valueFormatter={formatTokens} />} />
              <Area dataKey="inputTokens" type="monotone" stroke="var(--color-inputTokens)" fill="url(#fillInput)" />
              <Area dataKey="cachedInputTokens" type="monotone" stroke="var(--color-cachedInputTokens)" fill="url(#fillCachedInput)" />
              <Area dataKey="outputTokens" type="monotone" stroke="var(--color-outputTokens)" fill="none" strokeWidth={2} />
              <ChartLegend content={<ChartLegendContent />} />
            </AreaChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}

function ActivityHeatmapCard({
  rows,
  loading,
}: {
  rows: DailyUsageRow[]
  loading: boolean
}) {
  const { resolvedTheme } = useTheme()
  const colorScheme = resolvedTheme === "light" ? "light" : "dark"
  const cells = rows.map((row) => ({ date: row.day, count: row.inputTokens + row.outputTokens, level: 0 }))
  const positive = cells.map((cell) => cell.count).filter((count) => count > 0).sort((left, right) => left - right)
  const thresholds = positive.length === 0
    ? [0, 0, 0]
    : [
        positive[Math.floor(positive.length * 0.25)]!,
        positive[Math.floor(positive.length * 0.5)]!,
        positive[Math.floor(positive.length * 0.75)]!,
      ]
  for (const cell of cells) {
    cell.level = cell.count <= 0
      ? 0
      : cell.count <= thresholds[0]!
        ? 1
        : cell.count <= thresholds[1]!
          ? 2
          : cell.count <= thresholds[2]!
            ? 3
            : 4
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
                colorScheme={colorScheme}
                blockSize={18}
                blockMargin={5}
                blockRadius={3}
                weekStart={1}
                showWeekdayLabels={["mon", "wed", "fri"]}
                style={{ width: "100%" }}
                showTotalCount={false}
                theme={{
                  light: ["var(--heatmap-0)", "var(--heatmap-1)", "var(--heatmap-2)", "var(--heatmap-3)", "var(--heatmap-4)"],
                  dark: ["var(--heatmap-0)", "var(--heatmap-1)", "var(--heatmap-2)", "var(--heatmap-3)", "var(--heatmap-4)"],
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
            <p className="mt-2 text-center text-xs text-muted-foreground">
              最近 90 天共 {formatTokens(total)} Token · 活跃 {activeDays} 天
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function fillRecentDays(rows: DailyUsageRow[], endAtMs: number, days: number): DailyUsageRow[] {
  const endDay = utcDayStart(Math.max(0, endAtMs - 1))
  return fillDays(rows, endDay - (days - 1) * dayMs, days)
}

function fillDailyRange(rows: DailyUsageRow[], range: Range): DailyUsageRow[] {
  const endDay = utcDayStart(Math.max(range.startAtMs, range.endAtMs - 1))
  const firstRecordedDay = rows[0]?.day
  const startDay = range.name === "all"
    ? firstRecordedDay === undefined
      ? endDay
      : Date.parse(`${firstRecordedDay}T00:00:00.000Z`)
    : utcDayStart(range.startAtMs)
  const days = Math.max(1, Math.floor((endDay - startDay) / dayMs) + 1)
  return fillDays(rows, startDay, days)
}

function fillDays(rows: DailyUsageRow[], startDay: number, days: number): DailyUsageRow[] {
  const rowsByDay = new Map(rows.map((row) => [row.day, row]))
  const result: DailyUsageRow[] = []
  for (let index = 0; index < days; index += 1) {
    const day = toUtcDay(new Date(startDay + index * dayMs))
    result.push(rowsByDay.get(day) ?? {
      day,
      requestCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
  }
  return result
}

function utcDayStart(timestamp: number): number {
  const date = new Date(timestamp)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

function toUtcDay(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}
