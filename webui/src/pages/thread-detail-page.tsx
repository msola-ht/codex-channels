import { Link, useParams } from "react-router"

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
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
  const loading = run.loading || run.data === null || turns.loading || turns.data === null

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/threads">Threads</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-56 truncate">{id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <ErrorBanner error={error} />

      {loading
        ? <PageSkeleton rows={4} />
        : (
          <>
            <ThreadRunSummary
              latestTurn={run.data!.latestTurn}
              threadAggregate={run.data!.threadAggregate}
            />
            <TurnTable turns={turns.data!.turns} />
          </>
        )}
    </div>
  )
}
