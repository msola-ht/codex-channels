import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatCount, formatTokens, formatRequestOutcomes, formatTime } from "@/lib/format"
import { TokenHint } from "./token-tooltip"
import type { Aggregate, Range } from "@/lib/types"
import { cn } from "cn"

export function QuerySummary({ aggregate, range, turns, label, scopeLabel, loading = false }: { aggregate: Pick<Aggregate, "requestCount" | "requestOutcomes" | "inputTokens" | "outputTokens" | "cacheUsage" | "usageCoverage"> | null; range: Range<string> | "all"; turns?: number; label?: string; scopeLabel?: string; loading?: boolean }) {
  const { t } = useTranslation()
  const cache = formatCacheUsage(aggregate?.cacheUsage ?? null)
  const input = formatTokens(aggregate?.inputTokens)
  const output = formatTokens(aggregate?.outputTokens)
  const outcomes = formatRequestOutcomes(aggregate?.requestOutcomes ?? null, t)
  return (
    <span className={cn("flex shrink-0 flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground", loading && "invisible")} aria-hidden={loading || undefined}>
      {label === undefined ? null : <span>{label}</span>}
      <span>{scopeLabel ?? t("metrics.period", { range: range === "all" || range.name === "all" ? t("metrics.allHistory") : t("metrics.dateRange", { from: formatTime(range.startAtMs), to: formatTime(range.endAtMs) }) })}</span>
      {turns ? <span>{t("metrics.turns", { count: formatCount(turns) })}</span> : null}
      {aggregate?.requestCount ? <span>{t("metrics.requestsTotal", { count: formatCount(aggregate.requestCount) })}</span> : null}
      {outcomes ? <span>{outcomes}</span> : null}
      {input ? <TokenHint value={t("metrics.inputCache", { input, cached: cache.cached }).split(" · ").filter((_, index) => index === 0 || cache.cached).join(" · ")} /> : null}
      {cache.rate ? <span>{t("metrics.cacheRate", { rate: cache.rate })}</span> : null}
      {output ? <TokenHint value={t("metrics.outputTotal", { count: output })} /> : null}
    </span>
  )
}
