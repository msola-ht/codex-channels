import { translateApiError } from "@/lib/i18n/translate"
import { useTranslation } from "@/hooks/use-translation"
import { Link, useParams } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { TruncatedText } from "@/components/metrics/data-table"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { QueryFilters } from "@/components/metrics/query-filters"
import { QuerySummary } from "@/components/metrics/query-summary"
import { ThreadRunSummary } from "@/components/threads/thread-run-summary"
import { TurnTable } from "@/components/threads/turn-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useThreadRun, useThreadTurns } from "@/hooks/use-thread-detail"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { shortThreadId } from "@/lib/format"
import { metricsLink } from "@/lib/metrics-query"
import { cn } from "@/lib/utils"

export function ThreadDetailPage() {
  const { t } = useTranslation()
  const { id = "" } = useParams<{ id: string }>()
  const { query, update, pagination } = useMetricsQuery("all")
  const run = useThreadRun(id)
  const turns = useThreadTurns(id, query)
  const error = run.error ?? turns.error

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold" title={shortThreadId(id) === id ? undefined : id}>{t("threads.heading", { id: shortThreadId(id) })}</h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link to={metricsLink("/requests", query, { threadId: id })}>{t("threads.viewRequests")}</Link></Button>
          <Button variant="outline" asChild><Link to={metricsLink("/errors", query, { threadId: id })}>{t("threads.viewErrors")}</Link></Button>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} threadId={id} />
      <ErrorBanner error={translateApiError(t, error, run.error !== null ? run.errorCode : turns.errorCode)} pending={run.loading || turns.loading} onRetry={() => {
        if (run.error !== null) run.refetch()
        if (turns.error !== null) turns.refetch()
      }} />
      {error !== null ? null : turns.data === null ? <PageSkeleton rows={4} /> : (
        <>
          {run.data?.agentPath ? (
            <div className={cn("flex shrink-0 flex-wrap items-center gap-2 text-sm", (turns.loading || run.loading) && "invisible")} inert={turns.loading || run.loading} aria-hidden={turns.loading || run.loading || undefined}>
              <Badge variant="secondary">{t("threads.subagent")}</Badge>
              <TruncatedText text={run.data.agentPath} className="max-w-96" />
              {run.data.parentThreadId !== null ? <Link to={metricsLink(`/threads/${encodeURIComponent(run.data.parentThreadId)}`, query, { threadId: undefined, turnId: undefined })}>{t("threads.parentLink", { id: shortThreadId(run.data.parentThreadId) })}</Link> : null}
            </div>
          ) : null}
          <QuerySummary loading={turns.loading} aggregate={turns.data.aggregate} range={turns.data.range} turns={turns.data.turnCount} />
          <p className="shrink-0 text-sm text-muted-foreground">{t("threads.turnHint")}</p>
          {run.data === null ? null : (
            <details className={cn("shrink-0", (turns.loading || run.loading) && "invisible")} inert={turns.loading || run.loading} aria-hidden={turns.loading || run.loading || undefined}>
              <summary className="cursor-pointer text-sm text-muted-foreground">{t("threads.history")}</summary>
              <div className="mt-3"><ThreadRunSummary latestTurn={run.data.latestTurn} threadAggregate={run.data.threadAggregate} /></div>
            </details>
          )}
          <TurnTable loading={turns.loading} turns={turns.data.turns} threadId={id} query={query} pagination={pagination(turns.data)} />
        </>
      )}
    </div>
  )
}
