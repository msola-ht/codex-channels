import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatCount, formatTokens, formatRequestOutcomes, formatTime } from "@/lib/format"
import type { Aggregate, Range } from "@/lib/types"
import { cn } from "cn"

export function QuerySummary({ aggregate, range, turns, label, loading = false }: { aggregate: Pick<Aggregate, "requestCount" | "requestOutcomes" | "inputTokens" | "outputTokens" | "cacheUsage"> | null; range: Range<string> | "all"; turns?: number; label?: string; loading?: boolean }) {
  const { t } = useTranslation()
  const cache = formatCacheUsage(aggregate?.cacheUsage ?? null)
  return (
    <span className={cn("flex shrink-0 flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground", loading && "invisible")} aria-hidden={loading || undefined}>
      {label === undefined ? null : <span>{label}</span>}
      <span>{t("metrics.period", { range: range === "all" || range.name === "all" ? t("metrics.allHistory") : t("metrics.dateRange", { from: formatTime(range.startAtMs), to: formatTime(range.endAtMs) }) })}</span>
      {turns === undefined ? null : <span>{t("metrics.turns", { count: formatCount(turns) })}</span>}
      <span>{t("metrics.requestsTotal", { count: formatCount(aggregate?.requestCount ?? 0) })}</span>
      <span>{formatRequestOutcomes(aggregate?.requestOutcomes ?? null, t)}</span>
      <span>{t("metrics.inputCache", { input: formatTokens(aggregate?.inputTokens ?? 0), cached: cache.cached })}</span>
      <span>{t("metrics.cacheRate", { rate: cache.rate })}</span>
      <span>{t("metrics.outputTotal", { count: formatTokens(aggregate?.outputTokens ?? 0) })}</span>
    </span>
  )
}
