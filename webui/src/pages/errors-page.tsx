import { useState } from "react"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { RangeSelector } from "@/components/metrics/range-selector"
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
import { formatErrorMessage, formatErrorType, formatSuccessRate, formatTime } from "@/lib/format"
import type { RangeName } from "@/lib/types"

const PAGE_SIZE = 50

export function ErrorsPage() {
  const [range, setRange] = useState<RangeName>("24h")
  const [offset, setOffset] = useState(0)
  const [pageNumber, setPageNumber] = useState(1)
  const { data, loading, error } = useErrors(range, offset, PAGE_SIZE)
  const { language } = useLanguage()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">错误</h1>
          <p className="text-sm text-muted-foreground">失败请求记录，按发生时间倒序</p>
        </div>
        <RangeSelector
          value={range}
          onChange={(next) => {
            setRange(next)
            setOffset(0)
            setPageNumber(1)
          }}
        />
      </div>

      <ErrorBanner error={error} />

      {loading || data === null ? <PageSkeleton rows={5} /> : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              title="请求总数"
              value={data.errors.requestCount.toLocaleString("zh-CN")}
              description={`失败 ${data.errors.unsuccessfulRequestCount}`}
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
                          <TableCell className="max-w-md">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="block truncate text-xs text-muted-foreground">{message}</span>
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
                        <TableCell colSpan={6} className="h-16 text-center text-muted-foreground">
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
                      setOffset(Math.max(0, offset - PAGE_SIZE))
                      setPageNumber((current) => current - 1)
                    }}
                  >上一页</Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={data.nextOffset === null}
                    onClick={() => {
                      if (data.nextOffset === null) return
                      setOffset(data.nextOffset)
                      setPageNumber((current) => current + 1)
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
