import { useTranslation } from "@/hooks/use-translation"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TableHint } from "@/components/metrics/data-table"
import { InputTokenTooltip, OutputTokenTooltip } from "@/components/metrics/token-tooltip"
import { cn } from "cn"
import {
  formatCacheUsage,
  formatCount,
  formatRequestOutcomes,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { Aggregate, Range } from "@/lib/types"

export function ThreadPeriodSummary({ aggregate, subagentAggregate, treeAggregate, descendantsUnavailable, range, turnCount, subagentTurnCount, loading }: {
  aggregate: Aggregate | null
  subagentAggregate: Aggregate | null
  treeAggregate: Aggregate | null
  descendantsUnavailable: boolean
  range: Range<string>
  turnCount: number
  subagentTurnCount: number | null
  loading: boolean
}) {
  const { t } = useTranslation()
  return (
    <section className={cn("flex shrink-0 flex-col gap-3", loading && "invisible")} inert={loading} aria-hidden={loading || undefined} aria-label={t("threads.periodSummary")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium">{t("threads.periodSummary")}</h2>
        <span className="text-sm text-muted-foreground">{range.name === "all" ? t("metrics.allHistory") : t("metrics.dateRange", { from: formatTime(range.startAtMs), to: formatTime(range.endAtMs) })}</span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card size="sm">
          <CardHeader><CardTitle>{t("metrics.input")}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3">
              {[{ label: t("metrics.thread"), value: aggregate, unavailable: false, right: false }, { label: t("threads.tokenSubagents"), value: subagentAggregate, unavailable: descendantsUnavailable, right: true }].map(({ label, value, unavailable, right }) => (
                <div key={label} className={cn("min-w-0", right && "text-right")}>
                  <dt className="whitespace-nowrap text-sm text-muted-foreground">{label}<span className="ml-2 tabular-nums"><TableHint hint={t("metrics.cacheHitRate")}>{formatCacheUsage(unavailable ? null : value?.cacheUsage ?? null).rate}</TableHint></span></dt>
                  <dd className="break-words text-2xl font-semibold tabular-nums">{unavailable ? "—" : <InputTokenTooltip inputTokens={value?.inputTokens ?? 0} cachedInputTokens={value?.cachedInputTokens ?? null} cacheUsage={value?.cacheUsage} />}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader><CardTitle>{t("metrics.output")}</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-3">
              <div className="min-w-0"><dt className="text-sm text-muted-foreground">{t("metrics.thread")}</dt><dd className="break-words text-2xl font-semibold tabular-nums"><OutputTokenTooltip outputTokens={aggregate?.outputTokens ?? 0} reasoningOutputTokens={aggregate?.reasoningOutputTokens ?? 0} /></dd></div>
              <div className="min-w-0 text-right"><dt className="text-sm text-muted-foreground">{t("threads.tokenSubagents")}</dt><dd className="break-words text-2xl font-semibold tabular-nums">{descendantsUnavailable ? "—" : <OutputTokenTooltip outputTokens={subagentAggregate?.outputTokens ?? 0} reasoningOutputTokens={subagentAggregate?.reasoningOutputTokens ?? 0} />}</dd></div>
            </dl>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("threads.periodTotal")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-3 gap-3">
              <div className="min-w-0"><dt className="text-sm text-muted-foreground">{t("metrics.thread")}</dt><dd className="break-words text-2xl font-semibold tabular-nums">{formatTokens((aggregate?.inputTokens ?? 0) + (aggregate?.outputTokens ?? 0))}</dd></div>
              <div className="min-w-0 text-center"><dt className="text-sm text-muted-foreground">{t("threads.tokenSubagents")}</dt><dd className="break-words text-2xl font-semibold tabular-nums">{descendantsUnavailable ? "—" : formatTokens((subagentAggregate?.inputTokens ?? 0) + (subagentAggregate?.outputTokens ?? 0))}</dd></div>
              <div className="min-w-0 text-right"><dt className="text-sm text-muted-foreground">{t("threads.periodTotal")}</dt><dd className="break-words text-2xl font-semibold tabular-nums">{descendantsUnavailable ? "—" : formatTokens((treeAggregate?.inputTokens ?? 0) + (treeAggregate?.outputTokens ?? 0))}</dd></div>
            </dl>
          </CardContent>
        </Card>
      </div>
      <p className="text-sm text-muted-foreground tabular-nums" aria-label={t(descendantsUnavailable ? "threads.periodOwnActivitySummary" : "threads.periodActivitySummary")}>
        {[
          { label: t("metrics.turn"), thread: turnCount, subagents: descendantsUnavailable ? null : subagentTurnCount },
          { label: t("metrics.requests"), thread: aggregate?.requestCount ?? 0, subagents: descendantsUnavailable ? null : subagentAggregate?.requestCount ?? 0 },
        ].map(({ label, thread, subagents }) => (
          <span key={label}>
            <TableHint hint={t("threads.periodCountBreakdown", { thread: formatCount(thread), subagents: subagents === null ? "—" : formatCount(subagents) })}>
              <span className="whitespace-nowrap">{label} {subagents === null ? "—" : formatCount(thread + subagents)}</span>
            </TableHint>
            {" · "}
          </span>
        ))}
        {formatRequestOutcomes((descendantsUnavailable ? aggregate : treeAggregate)?.requestOutcomes ?? null, t)}
      </p>
      {descendantsUnavailable ? <p className="text-sm text-muted-foreground">{t("threads.turnDescendantsUnavailable")}</p> : null}
    </section>
  )
}
