import { Link, useParams } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
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
  const { id = "" } = useParams<{ id: string }>()
  const { query, update, pagination } = useMetricsQuery("all")
  const run = useThreadRun(id)
  const turns = useThreadTurns(id, query)
  const error = run.error ?? turns.error

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold" title={id}>会话 · {shortThreadId(id)}</h1>
        <div className="flex gap-2">
          <Button variant="outline" asChild><Link to={metricsLink("/requests", query, { threadId: id })}>查看请求</Link></Button>
          <Button variant="outline" asChild><Link to={metricsLink("/errors", query, { threadId: id })}>查看错误</Link></Button>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} threadId={id} />
      <ErrorBanner error={error} pending={run.loading || turns.loading} onRetry={() => {
        if (run.error !== null) run.refetch()
        if (turns.error !== null) turns.refetch()
      }} />
      {error !== null ? null : turns.data === null ? <PageSkeleton rows={4} /> : (
        <>
          {run.data?.agentPath ? (
            <div className={cn("flex shrink-0 flex-wrap items-center gap-2 text-sm", (turns.loading || run.loading) && "invisible")} inert={turns.loading || run.loading} aria-hidden={turns.loading || run.loading || undefined}>
              <Badge variant="secondary">子代理</Badge>
              <span className="max-w-96 truncate" title={run.data.agentPath}>{run.data.agentPath}</span>
              {run.data.parentThreadId !== null ? <Link to={metricsLink(`/threads/${encodeURIComponent(run.data.parentThreadId)}`, query, { threadId: undefined, turnId: undefined })}>父会话：{shortThreadId(run.data.parentThreadId)}</Link> : null}
            </div>
          ) : null}
          <QuerySummary loading={turns.loading} aggregate={turns.data.aggregate} range={turns.data.range} turns={turns.data.turnCount} />
          <p className="shrink-0 text-sm text-muted-foreground">以下为当前会话自身的期间轮次；点击 Turn 查看匹配请求。轮数只包含本机指标库有记录的 Turn。</p>
          {run.data === null ? null : (
            <details className={cn("shrink-0", (turns.loading || run.loading) && "invisible")} inert={turns.loading || run.loading} aria-hidden={turns.loading || run.loading || undefined}>
              <summary className="cursor-pointer text-sm text-muted-foreground">全部保留历史累计（含已关联子代理，不受上方筛选影响）</summary>
              <div className="mt-3"><ThreadRunSummary latestTurn={run.data.latestTurn} threadAggregate={run.data.threadAggregate} /></div>
            </details>
          )}
          <TurnTable loading={turns.loading} turns={turns.data.turns} threadId={id} query={query} pagination={pagination(turns.data)} />
        </>
      )}
    </div>
  )
}
