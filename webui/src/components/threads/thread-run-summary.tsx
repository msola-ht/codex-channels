import { useTranslation } from "@/hooks/use-translation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { StatCard } from "@/components/metrics/stat-card"
import {
  formatCount,
  formatTokens,
} from "@/lib/format"
import type { Aggregate, TurnSummary } from "@/lib/types"

export function ThreadRunSummary({
  latestTurn,
  threadAggregate,
}: {
  latestTurn: TurnSummary | null
  threadAggregate: (Omit<Aggregate, "cacheUsage"> & { turnCount: number }) | null
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
    <div className="grid gap-4 sm:grid-cols-3">
      <StatCard
        title={t("metrics.turn")}
        value={threadAggregate.turnCount}
        description={latestTurn === null ? t("threads.noLatest") : t("threads.latest", { count: formatCount(latestTurn.requestCount) })}
      />
      <StatCard
        title={t("metrics.requestCount")}
        value={formatCount(threadAggregate.requestCount)}
        description={t("metrics.failedTotal", { count: formatCount(threadAggregate.unsuccessfulRequestCount) })}
      />
      <StatCard
        title="Token"
        value={formatTokens(threadAggregate.inputTokens + threadAggregate.outputTokens)}
        description={t("metrics.inputOutput", { input: formatTokens(threadAggregate.inputTokens), output: formatTokens(threadAggregate.outputTokens) })}
      />
    </div>
  )
}
