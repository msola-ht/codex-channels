import { Link } from "react-router"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { QueryFilters } from "@/components/metrics/query-filters"
import { StatCard } from "@/components/metrics/stat-card"
import { StatusBadge } from "@/components/metrics/status-badge"
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useErrors } from "@/hooks/use-errors"
import { useLanguage } from "@/hooks/language-context"
import { formatCount, formatErrorMessage, formatErrorType, formatSuccessRate, formatTime } from "@/lib/format"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { metricsLink } from "@/lib/metrics-query"

export function ErrorsPage() {
  const { query, update } = useMetricsQuery("90d")
  const { data, loading, error } = useErrors(query)
  const { offset, limit } = query
  const pageNumber = Math.floor(offset / limit) + 1
  const { language } = useLanguage()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">错误</h1>
          <p className="text-sm text-muted-foreground">失败请求记录，按发生时间倒序</p>
        </div>
      </div>
      <QueryFilters query={query} onChange={update} />

      <ErrorBanner error={error} />

      {error !== null ? null : loading || data === null ? <PageSkeleton rows={5} /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
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
          <Card>
            <CardHeader>
              <CardTitle>错误记录</CardTitle>
              <CardDescription>每一行是一条失败请求；错误明细跟随当前界面语言显示</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <Table className="min-w-[900px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>时间</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>模型</TableHead>
                      <TableHead>会话 / 轮次</TableHead>
                      <TableHead>错误明细</TableHead>
                      <TableHead>HTTP</TableHead>
                      <TableHead>状态</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.records.map((record) => {
                      const message = record.errorMessage === null
                        ? formatErrorType(record.errorType ?? record.errorCode, language)
                        : formatErrorMessage(record.errorMessage, language)
                      return (
                        <TableRow key={record.id}>
                          <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{formatTime(record.recordedAtMs)}</TableCell>
                          <TableCell><ProviderBadge provider={record.provider} /></TableCell>
                          <TableCell className="max-w-48 truncate">{record.model ?? "—"}</TableCell>
                          <TableCell>{record.threadId === null ? "—" : <Link className="block max-w-40 truncate underline-offset-4 hover:underline" title={record.turnId ?? record.threadId} to={metricsLink("/requests", query, { threadId: record.threadId, turnId: record.turnId ?? undefined, status: undefined })}>{record.turnId ?? record.threadId}</Link>}</TableCell>
                          <TableCell className="max-w-md">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block truncate text-xs text-muted-foreground" tabIndex={0}>{message}</span>
                              </TooltipTrigger>
                              <TooltipContent side="right" className="max-w-md">
                                <p className="break-words text-xs">{message}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TableCell>
                          <TableCell className="tabular-nums">{record.httpStatus ?? "—"}</TableCell>
                          <TableCell><StatusBadge status={record.status} /></TableCell>
                        </TableRow>
                      )
                    })}
                    {data.records.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="h-16 text-center text-muted-foreground">
                          没有异常请求
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
