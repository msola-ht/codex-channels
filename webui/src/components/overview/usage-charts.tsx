import { useState } from "react"
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { formatTokens } from "@/lib/format"
import { toStackedUsageTrend } from "@/lib/trend"
import type { DailyUsageRow } from "@/lib/types"

const dayMs = 86_400_000

export function UsageCharts({
  rows,
  generatedAt,
  loading,
  error,
}: {
  rows: DailyUsageRow[]
  generatedAt: string | null
  loading: boolean
  error: string | null
}) {
  const unavailable = error !== null && rows.length === 0
  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner error={error} />
      {unavailable ? null : (
        <div className="grid items-start gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
          <ActivityHeatmapCard rows={rows} generatedAt={generatedAt} loading={loading} />
          <UsageTrendCard rows={rows} generatedAt={generatedAt} loading={loading} />
        </div>
      )}
    </div>
  )
}

function UsageTrendCard({
  rows,
  generatedAt,
  loading,
}: {
  rows: DailyUsageRow[]
  generatedAt: string | null
  loading: boolean
}) {
  const [timeRange, setTimeRange] = useState<"7d" | "30d" | "90d">("90d")
  const days = timeRange === "7d" ? 7 : timeRange === "90d" ? 90 : 30
  const reference = generatedAt === null ? new Date() : new Date(generatedAt)
  const today = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()))
  const rowsByDay = new Map(rows.map((row) => [row.day, row]))
  const rangeRows: DailyUsageRow[] = []
  for (let index = days - 1; index >= 0; index -= 1) {
    const day = toUtcDay(new Date(today.getTime() - index * dayMs))
    rangeRows.push(rowsByDay.get(day) ?? {
      day,
      requestCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    })
  }
  const data = toStackedUsageTrend(rangeRows)
  const hasData = rangeRows.some((row) => row.requestCount > 0)
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
            <CardDescription>最近 {days} 天，输入按缓存拆分</CardDescription>
          </div>
          <Select value={timeRange} onValueChange={(value) => setTimeRange(value as "7d" | "30d" | "90d")}>
            <SelectTrigger className="w-[132px] rounded-lg sm:w-[140px]" aria-label="选择趋势时间范围">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="rounded-xl">
              <SelectGroup>
                <SelectItem value="90d" className="rounded-lg">最近 90 天</SelectItem>
                <SelectItem value="30d" className="rounded-lg">最近 30 天</SelectItem>
                <SelectItem value="7d" className="rounded-lg">最近 7 天</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {loading && !hasData ? (
          <PageSkeleton rows={3} />
        ) : !hasData ? (
          <p className="text-sm text-muted-foreground">最近 {days} 天没有记录</p>
        ) : (
          <ChartContainer config={chartConfig} className="h-[230px] w-full">
            <AreaChart accessibilityLayer data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="fillUncachedInput" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-uncachedInputTokens)" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="var(--color-uncachedInputTokens)" stopOpacity={0.05} />
                </linearGradient>
                <linearGradient id="fillCachedInput" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-cachedInputTokens)" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="var(--color-cachedInputTokens)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={(day) => String(day).slice(5)} />
              <YAxis tickLine={false} axisLine={false} tickFormatter={formatTokens} width={52} />
              <ChartTooltip content={<ChartTooltipContent valueFormatter={formatTokens} sortByValue />} />
              <Area dataKey="uncachedInputTokens" type="monotone" stackId="input" stroke="var(--color-uncachedInputTokens)" fill="url(#fillUncachedInput)" />
              <Area dataKey="cachedInputTokens" type="monotone" stackId="input" stroke="var(--color-cachedInputTokens)" fill="url(#fillCachedInput)" />
              <Area dataKey="totalTokens" type="monotone" stroke="var(--color-totalTokens)" fill="none" strokeWidth={2} />
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
  generatedAt,
  loading,
}: {
  rows: DailyUsageRow[]
  generatedAt: string | null
  loading: boolean
}) {
  const { resolvedTheme } = useTheme()
  const colorScheme = resolvedTheme === "light" ? "light" : "dark"
  const byDay = new Map(rows.map((row) => [row.day, row.inputTokens + row.outputTokens]))
  const reference = generatedAt === null ? new Date() : new Date(generatedAt)
  const today = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()))
  const cells: Array<{ date: string; count: number; level: number }> = []
  for (let index = 89; index >= 0; index -= 1) {
    const date = new Date(today.getTime() - index * dayMs)
    const key = toUtcDay(date)
    cells.push({ date: key, count: byDay.get(key) ?? 0, level: 0 })
  }
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

function toUtcDay(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`
}
