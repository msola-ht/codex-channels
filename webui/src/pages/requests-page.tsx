import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { QueryFilters } from "@/components/metrics/query-filters"
import { QuerySummary } from "@/components/metrics/query-summary"
import { RequestsTable } from "@/components/requests/requests-table"
import { Button } from "@/components/ui/button"
import { useRequests } from "@/hooks/use-requests"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { useMetricsExport } from "@/hooks/use-metrics-export"

export function RequestsPage() {
  const state = useMetricsQuery("30d")
  const { query, update, sorting, onSortingChange } = state
  const { data, loading, error } = useRequests(query)
  const exporter = useMetricsExport(query)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">请求明细</h1>
        <Button variant="outline" disabled={exporter.pending || loading || error !== null} onClick={() => void exporter.download()}>
          {exporter.pending ? "正在导出…" : "导出全部匹配请求（JSON）"}
        </Button>
      </div>
      <QueryFilters query={query} onChange={update} />
      <ErrorBanner error={error ?? exporter.error} />
      {error !== null ? null : loading || data === null ? <PageSkeleton rows={8} /> : (
        <>
          <QuerySummary aggregate={data.aggregate} range={data.range} />
          <RequestsTable
            query={query}
            records={data.records}
            pageNumber={Math.floor(query.offset / query.limit) + 1}
            hasPrevious={query.offset > 0}
            hasNext={data.nextOffset !== null}
            onPrevious={() => update({ offset: Math.max(0, query.offset - query.limit) }, false)}
            onNext={() => { if (data.nextOffset !== null) update({ offset: data.nextOffset }, false) }}
            pageSize={query.limit}
            onPageSizeChange={(limit) => update({ limit })}
            sorting={sorting}
            onSortingChange={onSortingChange}
            filter={query.filter ?? ""}
            total={data.total}
          />
        </>
      )}
    </div>
  )
}
