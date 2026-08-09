import { useParams } from "react-router"
import { Link } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ThreadRunSummary } from "@/components/threads/thread-run-summary"
import { TurnTable } from "@/components/threads/turn-table"
import { Badge } from "@/components/ui/badge"
import { useThreadRun, useThreadTurns } from "@/hooks/use-thread-detail"
import { shortThreadId } from "@/lib/format"

export function ThreadDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const run = useThreadRun(id)
  const turns = useThreadTurns(id)

  const error = run.error ?? turns.error
  const loading = error === null
    && (run.loading || turns.loading || run.data === null || turns.data === null)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="shrink-0">
        <ErrorBanner error={error} />
      </div>

      {loading
        ? <PageSkeleton rows={4} />
        : run.data !== null && turns.data !== null ? (
          <>
            {run.data.agentPath !== null ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
                <Badge variant="secondary">子代理</Badge>
                <span
                  className="max-w-96 truncate"
                  title={run.data.agentPath}
                >
                  {run.data.agentPath}
                </span>
                {run.data.parentThreadId !== null ? (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <Link
                      to={`/threads/${run.data.parentThreadId}`}
                      className="underline-offset-4 hover:underline"
                      title={run.data.parentThreadId}
                    >
                      父会话：{shortThreadId(run.data.parentThreadId)}
                    </Link>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="shrink-0">
              <ThreadRunSummary
                latestTurn={run.data.latestTurn}
                threadAggregate={run.data.threadAggregate}
              />
            </div>
            <TurnTable turns={turns.data.turns} />
          </>
        ) : null}
    </div>
  )
}
