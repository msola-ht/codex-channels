import { useParams } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ThreadRunSummary } from "@/components/threads/thread-run-summary"
import { TurnTable } from "@/components/threads/turn-table"
import { useThreadRun, useThreadTurns } from "@/hooks/use-thread-detail"

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
