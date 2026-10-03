import { ErrorsTable } from "@/components/requests/errors-table"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { QueryFilters } from "@/components/metrics/query-filters"
import { StatCard } from "@/components/metrics/stat-card"
import { Skeleton } from "@/components/ui/skeleton"
import { useErrors } from "@/hooks/use-errors"
import { useTranslation } from "@/hooks/use-translation"
import { formatCount, formatSuccessRate } from "@/lib/format"
import { translateApiError } from "@/lib/i18n/translate"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { cn } from "cn"

export function ErrorsPage() {
  const { query, update } = useMetricsQuery("30d")
  const { data, loading, error, errorCode, refetch } = useErrors(query)
  const { offset, limit } = query
  const pageNumber = Math.floor(offset / limit) + 1
  const { t } = useTranslation()

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{t("pages.errors")}</h1>
          <p className="text-sm text-muted-foreground">{t("errorList.description")}</p>
        </div>
      </div>
      {error === null && data !== null ? (
          <div className="relative" aria-busy={loading}>
            <div className={cn("grid gap-4 sm:grid-cols-2 xl:grid-cols-4", loading && "invisible")} aria-hidden={loading || undefined}>
              <StatCard
                value={formatCount(data.errors.requestCount)}
                description={t("errorList.requestTotal", { count: formatCount(data.errors.unsuccessfulRequestCount) })}
              />
              <StatCard
                value={formatSuccessRate(
                  data.errors.requestCount,
                  data.errors.unsuccessfulRequestCount,
                )}
                description={t("errorList.successRate", { shown: data.records.length, total: data.total })}
              />
            </div>
            {loading ? <Skeleton className="absolute inset-0" /> : null}
          </div>
      ) : null}
      <QueryFilters query={query} onChange={update} showThreadFilters={false} />

      <ErrorBanner error={translateApiError(t, error, errorCode)} onRetry={refetch} pending={loading} />

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
