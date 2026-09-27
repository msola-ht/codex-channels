import type { ComponentProps } from "react"
import { Link } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { FastBadge } from "@/components/metrics/service-tier"
import { QueryFilters } from "@/components/metrics/query-filters"
import { StatCard } from "@/components/metrics/stat-card"
import { StatusBadge } from "@/components/metrics/status-badge"
import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { useErrors } from "@/hooks/use-errors"
import { useTranslation } from "@/hooks/use-translation"
import { formatCount, formatErrorMessage, formatErrorType, formatSuccessRate, formatTime } from "@/lib/format"
import { translateApiError } from "@/lib/i18n/translate"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { metricsLink } from "@/lib/metrics-query"
import { cn } from "@/lib/utils"

function ErrorCell({ loading, children, ...props }: ComponentProps<typeof TableCell> & { loading: boolean }) {
  return (
    <TableCell {...props}>
      <div className="relative">
        <div className={cn(loading && "invisible")} aria-hidden={loading || undefined}>{children}</div>
        {loading ? <Skeleton className="absolute inset-0" /> : null}
      </div>
    </TableCell>
  )
}

export function ErrorsPage() {
  const { query, update } = useMetricsQuery("30d")
  const { data, loading, error, errorCode, refetch } = useErrors(query)
  const { offset, limit } = query
  const pageNumber = Math.floor(offset / limit) + 1
  const { t, language } = useTranslation()

  return (
    <div className="flex min-w-0 flex-col gap-6">
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
        <>
          <Card className="min-w-0" aria-busy={loading}>
            <CardHeader>
              <CardTitle>{t("errorList.tableTitle")}</CardTitle>
              <CardDescription>{t("errorList.tableDescription")}</CardDescription>
              {loading ? <span className="sr-only" role="status">{t("errorList.loadingRecords")}</span> : null}
            </CardHeader>
            <CardContent inert={loading}>
              <div className="overflow-x-auto">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("metrics.time")}</TableHead>
                      <TableHead>{t("metrics.provider")}</TableHead>
                      <TableHead>{t("metrics.model")}</TableHead>
                      <TableHead>{t("filters.status")}</TableHead>
                      <TableHead className="text-right">HTTP</TableHead>
                      <TableHead>{t("errorList.detailColumn")}</TableHead>
                      <TableHead>{t("errorList.threadColumn")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.records.map((record) => {
                      const message = record.errorMessage === null
                        ? formatErrorType(record.errorType ?? record.errorCode, language)
                        : formatErrorMessage(record.errorMessage, language)
                      return (
                        <TableRow key={record.id}>
                          <ErrorCell loading={loading} className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(record.recordedAtMs)}</ErrorCell>
                          <ErrorCell loading={loading}><ProviderBadge provider={record.provider} /></ErrorCell>
                          <ErrorCell loading={loading}><span className="flex items-center gap-2 whitespace-nowrap"><TrafficModel provider={record.provider} request={record.model} responses={[]} upstream={record.upstreamProvider} /><FastBadge tier={record.requestServiceTier} source="request" responseTier={record.serviceTier} /></span></ErrorCell>
                          <ErrorCell loading={loading}><StatusBadge status={record.status} /></ErrorCell>
                          <ErrorCell loading={loading} className="text-right tabular-nums">{record.httpStatus ?? "—"}</ErrorCell>
                          <ErrorCell loading={loading} className="max-w-md">
                            {record.errorCode ? <TableHint hint={`${message} · ${t("common.errorCode", { code: record.errorCode })}`}>
                              <span className="block max-w-md truncate text-xs text-muted-foreground">{message}</span>
                            </TableHint> : <TruncatedText text={message} className="max-w-md text-xs text-muted-foreground" />}
                          </ErrorCell>
                          <ErrorCell loading={loading}>{record.threadId === null ? "—" : <TruncatedText asChild text={record.turnId ?? record.threadId} className="max-w-40"><Link className="underline-offset-4 hover:underline" to={metricsLink("/requests", query, { threadId: record.threadId, turnId: record.turnId ?? undefined, status: undefined })}>{record.turnId ?? record.threadId}</Link></TruncatedText>}</ErrorCell>
                        </TableRow>
                      )
                    })}
                    {data.records.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-16 text-center text-muted-foreground">
                          {loading ? <Skeleton className="h-5 w-full" /> : t("common.noFailedRequests")}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">{t("common.page", { page: pageNumber })}</p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={offset === 0}
                    onClick={() => {
                      if (offset === 0) return
                      update({ offset: Math.max(0, offset - limit) }, false)
                    }}
                  >{t("common.previous")}</Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={data.nextOffset === null}
                    onClick={() => {
                      if (data.nextOffset === null) return
                      update({ offset: data.nextOffset }, false)
                    }}
                  >{t("common.next")}</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
