import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { QueryFilters } from "@/components/metrics/query-filters"
import { QuerySummary } from "@/components/metrics/query-summary"
import { ThreadTable } from "@/components/threads/thread-table"
import { useThreads } from "@/hooks/use-threads"
import { useMetricsQuery } from "@/hooks/use-metrics-query"

export function ThreadsPage() {
  const { query, update, pagination } = useMetricsQuery("all", "last")
  const { data, loading, error, refetch } = useThreads(query)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
      <h1 className="shrink-0 text-xl font-semibold">Threads</h1>
      <QueryFilters query={query} onChange={update} />
      <ErrorBanner error={error} onRetry={refetch} pending={loading} />
      {error !== null ? null : data === null ? <PageSkeleton rows={5} /> : (
        <>
          <QuerySummary loading={loading} aggregate={data.aggregate} range={data.range} turns={data.turnCount} />
          <ThreadTable loading={loading} threads={data.threads} query={query} pagination={pagination(data)} />
        </>
      )}
    </div>
  )
}
