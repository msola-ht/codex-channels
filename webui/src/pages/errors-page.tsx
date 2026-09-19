import type { ComponentProps } from "react"
import { Link } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { QueryFilters } from "@/components/metrics/query-filters"
import { StatCard } from "@/components/metrics/stat-card"
import { StatusBadge } from "@/components/metrics/status-badge"
import { TableHint } from "@/components/metrics/data-table"
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
import { useLanguage } from "@/hooks/language-context"
import { formatCount, formatErrorMessage, formatErrorType, formatSuccessRate, formatTime } from "@/lib/format"
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
  const { data, loading, error, refetch } = useErrors(query)
  const { offset, limit } = query
  const pageNumber = Math.floor(offset / limit) + 1
  const { language } = useLanguage()

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">错误</h1>
          <p className="text-sm text-muted-foreground">失败请求记录，按发生时间倒序</p>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} />

      <ErrorBanner error={error} onRetry={refetch} pending={loading} />

      {error !== null ? null : data === null ? <PageSkeleton rows={5} /> : (
        <>
          <div className="relative" aria-busy={loading}>
            <div className={cn("grid gap-4 sm:grid-cols-2", loading && "invisible")} aria-hidden={loading || undefined}>
              <StatCard
                title="请求总数"
                value={formatCount(data.errors.requestCount)}
                description={`失败 ${formatCount(data.errors.unsuccessfulRequestCount)}`}
              />
              <StatCard
                title="成功率"
                value={formatSuccessRate(
                  data.errors.requestCount,
                  data.errors.unsuccessfulRequestCount,
                )}
                description={`当前显示 ${data.records.length} / ${data.total} 条失败记录`}
              />
            </div>
            {loading ? <Skeleton className="absolute inset-0" /> : null}
          </div>
          <Card className="min-w-0" aria-busy={loading}>
            <CardHeader>
              <CardTitle>错误记录</CardTitle>
              <CardDescription>每一行是一条失败请求；错误明细跟随当前界面语言显示</CardDescription>
              {loading ? <span className="sr-only" role="status">正在加载错误记录…</span> : null}
            </CardHeader>
            <CardContent inert={loading}>
              <div className="overflow-x-auto">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>模型</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead className="text-right">HTTP</TableHead>
                      <TableHead>错误明细</TableHead>
                      <TableHead>会话 / 轮次</TableHead>
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
                          <ErrorCell loading={loading}><TableHint hint={record.model ?? "未提供模型"}><span className="block max-w-48 truncate">{record.model ?? "—"}</span></TableHint></ErrorCell>
                          <ErrorCell loading={loading}><StatusBadge status={record.status} /></ErrorCell>
                          <ErrorCell loading={loading} className="text-right tabular-nums">{record.httpStatus ?? "—"}</ErrorCell>
                          <ErrorCell loading={loading} className="max-w-md">
                            <TableHint hint={`${message}${record.errorCode ? ` · 错误码：${record.errorCode}` : ""}`}>
                              <span className="block max-w-md truncate text-xs text-muted-foreground">{message}</span>
                            </TableHint>
                          </ErrorCell>
                          <ErrorCell loading={loading}>{record.threadId === null ? "—" : <Link className="block max-w-40 truncate underline-offset-4 hover:underline" title={record.turnId ?? record.threadId} to={metricsLink("/requests", query, { threadId: record.threadId, turnId: record.turnId ?? undefined, status: undefined })}>{record.turnId ?? record.threadId}</Link>}</ErrorCell>
                        </TableRow>
                      )
                    })}
                    {data.records.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-16 text-center text-muted-foreground">
                          {loading ? <Skeleton className="h-5 w-full" /> : "没有异常请求"}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">第 {pageNumber} 页</p>
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
                  >上一页</Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={data.nextOffset === null}
                    onClick={() => {
                      if (data.nextOffset === null) return
                      update({ offset: data.nextOffset }, false)
                    }}
                  >下一页</Button>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
