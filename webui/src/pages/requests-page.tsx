import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { QueryFilters } from "@/components/metrics/query-filters"
import { QuerySummary } from "@/components/metrics/query-summary"
import { RequestsTable } from "@/components/requests/requests-table"
import { Button } from "@/components/ui/button"
import { useRequests } from "@/hooks/use-requests"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { useMetricsExport } from "@/hooks/use-metrics-export"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiError, translateApiErrorCode } from "@/lib/i18n/translate"

export function RequestsPage() {
  const { t } = useTranslation()
  const state = useMetricsQuery("30d")
  const { query, update, sorting, onSortingChange } = state
  const { data, loading, refreshing, error, errorCode, refetch, notificationStatus } = useRequests(query)
  const exporter = useMetricsExport(query)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6" aria-busy={refreshing}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{t("requests.title")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-muted-foreground" role="status">{query.offset > 0 ? t("requests.historyUpdatesPaused") : t(`delivery.notifications.${notificationStatus}`)}</span>
          <Button variant="outline" disabled={refreshing} onClick={refetch}>{refreshing ? t("common.refreshing") : t("common.refresh")}</Button>
          <Button variant="outline" disabled={exporter.pending || refreshing || error !== null} onClick={() => void exporter.download()}>
            {exporter.pending ? t("requests.exporting") : t("requests.export")}
          </Button>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} showThreadFilters={false} />
      <ErrorBanner error={translateApiError(t, error, errorCode)} onRetry={refetch} pending={refreshing} />
      <ErrorBanner error={exporter.failed ? translateApiErrorCode(t, exporter.errorCode) : null} onRetry={() => void exporter.download()} pending={exporter.pending || refreshing || error !== null} />
      {error !== null ? null : data === null ? <PageSkeleton rows={8} /> : (
        <>
          <QuerySummary loading={loading} aggregate={data.aggregate} range={data.range} />
          <RequestsTable
            key={JSON.stringify(query)}
            loading={loading}
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
