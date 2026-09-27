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
import { useTranslation } from "@/hooks/use-translation"
import { formatTokens } from "@/lib/format"
import type { Translate } from "@/lib/i18n/messages"
import { fillRecentDays, usageTrendRows, type UsageTrendRow } from "@/lib/trend"
import type { DailyUsageRow, RangeName, UsageTrendResponse } from "@/lib/types"

const rangeKeys = ["today", "yesterday", "24h", "7d", "30d", "90d", "all"] as const satisfies readonly RangeName[]

/** 自定义范围以 `from..to` 形式返回；其余范围名映射到字典键，未知名称保留原样。 */
function overviewRangeLabel(t: Translate, name: string): string {
  if (name.includes("..")) {
    const [from = "", to = ""] = name.split("..")
    return t("overview.customRange", { from, to })
  }
  const key = rangeKeys.find((candidate) => candidate === name)
  return key === undefined ? name : t(`ranges.${key}`)
}

export function UsageCharts({
  trend,
  heatmapRows,
  heatmapEndAtMs,
  heatmapLoading,
  error,
}: {
  trend: UsageTrendResponse
  heatmapRows: DailyUsageRow[]
  heatmapEndAtMs: number
  heatmapLoading: boolean
  error: string | null
}) {
  const { t } = useTranslation()
  const filledTrendRows = usageTrendRows(trend)
  const filledHeatmapRows = heatmapLoading && heatmapRows.length === 0
    ? []
    : fillRecentDays(heatmapRows, heatmapEndAtMs, 90)
  const rangeLabel = overviewRangeLabel(t, trend.range.name)
  return (
    <div className="flex flex-col gap-3">
      <ErrorBanner error={error} />
      <div className="grid items-stretch gap-4 xl:grid-cols-[420px_minmax(0,1fr)]">
        <ActivityHeatmapCard rows={filledHeatmapRows} loading={heatmapLoading} />
        <UsageTrendCard rows={filledTrendRows} rangeLabel={rangeLabel} granularity={trend.granularity} />
      </div>
    </div>
  )
}

function UsageTrendCard({
  rows,
  rangeLabel,
  granularity,
}: {
  rows: UsageTrendRow[]
  rangeLabel: string
  granularity: UsageTrendResponse["granularity"]
}) {
  const { t } = useTranslation()
  const data = rows
  const hasData = rows.some((row) => row.requestCount > 0)
  const chartConfig: ChartConfig = {
    inputTokens: { label: t("overview.legendInput"), color: "var(--chart-1)" },
    cachedInputTokens: { label: t("overview.legendCached"), color: "var(--chart-2)" },
    outputTokens: { label: t("overview.legendOutput"), color: "var(--chart-3)" },
  }

  return (
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle>{t("overview.trendTitle")}</CardTitle>
        <CardDescription>{t(granularity === "hour" ? "overview.trendDescriptionHour" : "overview.trendDescriptionDay", { range: rangeLabel })}</CardDescription>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <Empty className="h-[230px] p-4"><EmptyHeader><EmptyTitle>{t("overview.trendEmpty", { range: rangeLabel })}</EmptyTitle></EmptyHeader></Empty>
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
              <XAxis dataKey="period" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} interval="preserveStartEnd" tickFormatter={(period) => String(period).slice(granularity === "hour" ? 11 : 5)} />
              <YAxis yAxisId="input" domain={[0, "auto"]} tickLine={false} axisLine={false} tickFormatter={formatTokens} width={52} />
              <YAxis yAxisId="output" orientation="right" domain={[0, "auto"]} tickLine={false} axisLine={false} tickFormatter={formatTokens} width={52} tick={{ style: { fill: "var(--color-outputTokens)" } }} />
              <ChartTooltip content={<ChartTooltipContent valueFormatter={formatTokens} />} />
              <Area yAxisId="input" dataKey="inputTokens" type="monotone" stroke="var(--color-inputTokens)" fill="url(#fillInput)" dot={data.length === 1} />
              <Area yAxisId="input" dataKey="cachedInputTokens" type="monotone" stroke="var(--color-cachedInputTokens)" fill="url(#fillCachedInput)" dot={data.length === 1} />
              <Area yAxisId="output" dataKey="outputTokens" type="monotone" stroke="var(--color-outputTokens)" fill="none" strokeWidth={2} dot={data.length === 1} />
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
  const { t, language } = useTranslation()
  const { resolvedTheme } = useTheme()
  const locale = language === "en" ? "en-US" : "zh-CN"
  const monthLabels = Array.from({ length: 12 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { month: language === "en" ? "short" : "long", timeZone: "UTC" })
      .format(new Date(Date.UTC(2024, index, 1))))
  const weekdayLabels = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" })
      .format(new Date(Date.UTC(2024, 0, 7 + index))))
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
    <Card size="sm" className="h-full">
      <CardHeader>
        <CardTitle>{t("overview.heatmapTitle")}</CardTitle>
        <CardDescription>{t("overview.heatmapDescription")}</CardDescription>
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
                  months: monthLabels,
                  weekdays: weekdayLabels,
                  legend: { less: t("overview.heatmapLess"), more: t("overview.heatmapMore") },
                }}
                tooltips={{
                  activity: { text: (activity) => t("overview.heatmapActivity", {
                    date: activity.date, tokens: formatTokens(activity.count),
                  }) },
                }}
              />
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">
              {t("overview.heatmapSummary", { total: formatTokens(total), days: activeDays })}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
