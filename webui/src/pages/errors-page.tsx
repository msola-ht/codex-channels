import { RefreshStatus } from "@/components/metrics/refresh-status"
import { ErrorsTable } from "@/components/requests/errors-table"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { QueryFilters } from "@/components/metrics/query-filters"
import { Button } from "@/components/ui/button"
import { useErrors } from "@/hooks/use-errors"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiError } from "@/lib/i18n/translate"
import { useMetricsQuery } from "@/hooks/use-metrics-query"

export function ErrorsPage() {
  const { query, update } = useMetricsQuery("30d")
  const { data, loading, refreshing, error, errorCode, refetch, notificationStatus, lastUpdatedAt } = useErrors(query)
  const { offset, limit } = query
  const pageNumber = Math.floor(offset / limit) + 1
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6" aria-busy={refreshing}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("pages.errors")}</h1>
          <p className="text-sm text-muted-foreground">{t("errorList.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RefreshStatus status={notificationStatus} updatedAt={lastUpdatedAt} failed={error !== null} history={offset > 0} />
          <Button variant="outline" disabled={refreshing} onClick={refetch}>{refreshing ? t("common.refreshing") : t("common.refresh")}</Button>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} showThreadFilters={false} revision={data} />

      <ErrorBanner error={translateApiError(t, error, errorCode)} onRetry={refetch} pending={refreshing} />

      {error !== null ? null : data === null ? <PageSkeleton rows={5} /> : (
        <ErrorsTable records={data.records} query={query} loading={loading}
          pagination={{ mode: "server", pageNumber, pageSize: limit, serverTotal: data.total, sorting: [], onSortingChange: () => {},
            hasPrevious: offset > 0, hasNext: data.nextOffset !== null,
            onPrevious: () => update({ offset: Math.max(0, offset - limit) }, false),
            onNext: () => { if (data.nextOffset !== null) update({ offset: data.nextOffset }, false) },
            onPageSizeChange: limit => update({ limit, offset: 0 }, false) }} />
      )}
    </div>
  )
}
