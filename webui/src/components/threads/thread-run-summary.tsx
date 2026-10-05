import { useTranslation } from "@/hooks/use-translation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { StatCard } from "@/components/metrics/stat-card"
import { InputTokenTooltip } from "@/components/metrics/token-tooltip"
import { cn } from "cn"
import {
  formatCacheUsage,
  formatCount,
  formatRequestOutcomes,
  formatInterruptionSummary,
  formatInterruptedUsage,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { Aggregate, Range, RequestInterruptionSummary } from "@/lib/types"

export function ThreadPeriodSummary({ aggregate, range, turnCount, loading }: {
  aggregate: Aggregate | null
  range: Range<string>
  turnCount: number
  loading: boolean
}) {
  const { t } = useTranslation()
  return (
    <section className={cn("flex shrink-0 flex-col gap-3", loading && "invisible")} inert={loading} aria-hidden={loading || undefined} aria-label={t("threads.ownSummary")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{t("threads.ownSummary")}</h2>
        <span className="text-sm text-muted-foreground">{range.name === "all" ? t("metrics.allHistory") : t("metrics.dateRange", { from: formatTime(range.startAtMs), to: formatTime(range.endAtMs) })}</span>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard title={t("metrics.turn")} value={formatCount(turnCount)} />
        <StatCard title={t("metrics.requestCount")} value={formatCount(aggregate?.requestCount ?? 0)} description={formatRequestOutcomes(aggregate?.requestOutcomes ?? null, t)} />
        <StatCard title={t("metrics.input")} value={<InputTokenTooltip inputTokens={aggregate?.inputTokens ?? 0} cachedInputTokens={aggregate?.cachedInputTokens ?? null} cacheUsage={aggregate?.cacheUsage} />} description={t("metrics.cacheRate", { rate: formatCacheUsage(aggregate?.cacheUsage ?? null).rate })} />
        <StatCard title={t("metrics.output")} value={formatTokens(aggregate?.outputTokens ?? 0)} />
      </div>
    </section>
  )
}

export function ThreadRunSummary({
  threadAggregate,
}: {
  threadAggregate: (Omit<Aggregate, "cacheUsage"> & { turnCount: number; interruptionSummary: RequestInterruptionSummary }) | null
}) {
  const { t } = useTranslation()
  if (threadAggregate === null) {
    return (
      <Alert>
        <AlertTitle>{t("threads.noData")}</AlertTitle>
        <AlertDescription>{t("threads.noMetrics")}</AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      <p className="text-muted-foreground">{t("threads.historyHint")}</p>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {[
          [t("metrics.turn"), formatCount(threadAggregate.turnCount)],
          [t("metrics.requestCount"), formatCount(threadAggregate.requestCount)],
          [t("status.completed"), formatCount(threadAggregate.requestOutcomes.completed)],
          [t("metrics.interrupted"), formatCount(threadAggregate.requestOutcomes.interrupted)],
          [t("metrics.failures"), formatCount(threadAggregate.requestOutcomes.failed)],
          [t("metrics.incompleteObservation"), formatCount(threadAggregate.requestOutcomes.incomplete)],
          [t("metrics.input"), formatInterruptedUsage(threadAggregate.inputTokens, threadAggregate.interruptionSummary)],
          [t("metrics.output"), formatInterruptedUsage(threadAggregate.outputTokens, threadAggregate.interruptionSummary)],
          [t("threads.totalTokens"), formatInterruptedUsage(threadAggregate.inputTokens + threadAggregate.outputTokens, threadAggregate.interruptionSummary)],
        ].map(([label, value]) => <div key={label} className="flex items-baseline gap-2"><dt className="text-muted-foreground">{label}</dt><dd className="tabular-nums">{value}</dd></div>)}
      </dl>
      {threadAggregate.requestOutcomes.interrupted > 0 && <p className="text-muted-foreground">{formatInterruptionSummary(threadAggregate.interruptionSummary, t)}</p>}
    </div>
  )
}
