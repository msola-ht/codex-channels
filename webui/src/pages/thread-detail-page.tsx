import { RefreshStatus } from "@/components/metrics/refresh-status"
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
import { ThreadSubagents } from "@/components/threads/thread-subagents"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useThreadDetail } from "@/hooks/use-thread-detail"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { shortThreadId } from "@/lib/format"
import { metricsLink } from "@/lib/metrics-query"
import { cn } from "cn"

export function ThreadDetailPage() {
  const { t } = useTranslation()
  const { id = "" } = useParams<{ id: string }>()
  const { query, update, pagination } = useMetricsQuery("all")
  const { data, loading, refreshing, error, errorCode, refetch, notificationStatus, lastUpdatedAt, revision } = useThreadDetail(id, query)
  const run = data?.run
  const turns = data?.turns

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6" aria-busy={refreshing}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold" title={shortThreadId(id) === id ? undefined : id}>{t("threads.heading", { id: shortThreadId(id) })}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <RefreshStatus status={notificationStatus} updatedAt={lastUpdatedAt} failed={error !== null} history={query.offset > 0} />
          <Button variant="outline" disabled={refreshing} onClick={refetch}>{refreshing ? t("common.refreshing") : t("common.refresh")}</Button>
          <Button variant="outline" render={<Link to={metricsLink("/requests", query, { threadId: id })} />} nativeButton={false}>{t("threads.viewRequests")}</Button>
          <Button variant="outline" render={<Link to={metricsLink("/errors", query, { threadId: id })} />} nativeButton={false}>{t("threads.viewErrors")}</Button>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} threadId={id} revision={data} />
      <ErrorBanner error={translateApiError(t, error, errorCode)} pending={refreshing} onRetry={refetch} />
      {error !== null ? null : turns === undefined || run === undefined ? <PageSkeleton rows={4} /> : (
        <>
          {run.agentPath ? (
            <div className={cn("flex shrink-0 flex-wrap items-center gap-2 text-sm", loading && "invisible")} inert={loading} aria-hidden={loading || undefined}>
              <Badge variant="secondary">{t("threads.subagent")}</Badge>
              <TruncatedText text={run.agentPath} className="max-w-96" />
              {run.parentThreadId !== null ? <Link to={metricsLink(`/threads/${encodeURIComponent(run.parentThreadId)}`, { range: "all" })}>{t("threads.parentLink", { id: shortThreadId(run.parentThreadId) })}</Link> : null}
              {run.parentThreadId !== null && run.parentTurnId !== null ? <Tooltip>
                <TooltipTrigger aria-description={t("threads.creationTurnHint")} render={<Link to={metricsLink("/requests", { range: "all", threadId: run.parentThreadId, turnId: run.parentTurnId })} />}>{t("threads.creationTurnLink", { id: shortThreadId(run.parentTurnId) })}</TooltipTrigger>
                <TooltipContent><p>{t("threads.creationTurnHint")}</p></TooltipContent>
              </Tooltip> : null}
            </div>
          ) : null}
          <QuerySummary loading={loading} aggregate={turns.aggregate} range={turns.range} turns={turns.turnCount} />
          <p className="shrink-0 text-sm text-muted-foreground">{t("threads.turnHint")}</p>
          <details className={cn("shrink-0", loading && "invisible")} inert={loading} aria-hidden={loading || undefined}>
            <summary className="cursor-pointer text-sm text-muted-foreground">{t("threads.history")}</summary>
            <div className="mt-3"><ThreadRunSummary latestTurn={run.latestTurn} threadAggregate={run.threadAggregate} /></div>
          </details>
          <div className="flex min-h-[32rem] shrink-0 flex-col">
            <TurnTable loading={loading} turns={turns.turns} threadId={id} query={query} pagination={pagination(turns)} />
          </div>
        </>
      )}
      <ThreadSubagents key={id} threadId={id} revision={revision} />
    </div>
  )
}
