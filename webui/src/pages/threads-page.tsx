import { RefreshStatus } from "@/components/metrics/refresh-status"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiError } from "@/lib/i18n/translate"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { QueryFilters } from "@/components/metrics/query-filters"
import { QuerySummary } from "@/components/metrics/query-summary"
import { ThreadTable } from "@/components/threads/thread-table"
import { Button } from "@/components/ui/button"
import { useThreads } from "@/hooks/use-threads"
import { useMetricsQuery } from "@/hooks/use-metrics-query"

export function ThreadsPage() {
  const { t } = useTranslation()
  const { query, update, pagination } = useMetricsQuery("all", "last")
  const { data, loading, refreshing, error, errorCode, refetch, notificationStatus, lastUpdatedAt } = useThreads(query)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6" aria-busy={refreshing}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="shrink-0 text-xl font-semibold">{t("pages.threads")}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <RefreshStatus status={notificationStatus} updatedAt={lastUpdatedAt} failed={error !== null} history={query.offset > 0} />
          <Button variant="outline" disabled={refreshing} onClick={refetch}>{refreshing ? t("common.refreshing") : t("common.refresh")}</Button>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} revision={data} />
      <ErrorBanner error={translateApiError(t, error, errorCode)} onRetry={refetch} pending={refreshing} />
      {error !== null ? null : data === null ? <PageSkeleton rows={5} /> : (
        <>
          <QuerySummary loading={loading} aggregate={data.aggregate} range={data.range} turns={data.turnCount} />
          <ThreadTable loading={loading} threads={data.threads} query={query} pagination={pagination(data)} />
        </>
      )}
    </div>
  )
}
