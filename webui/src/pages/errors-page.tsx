import { useState } from "react"

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
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { RangeSelector } from "@/components/metrics/range-selector"
import { StatCard } from "@/components/metrics/stat-card"
import { StatusBadge } from "@/components/metrics/status-badge"
import { useErrors } from "@/hooks/use-errors"
import { useLanguage } from "@/hooks/language-context"
import { formatErrorType, formatSuccessRate, formatTime } from "@/lib/format"
import type { RangeName } from "@/lib/types"

export function ErrorsPage() {
  const [range, setRange] = useState<RangeName>("24h")
  const { data, loading, error } = useErrors(range)
  const { language } = useLanguage()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">错误</h1>
          <p className="text-sm text-muted-foreground">异常请求聚合</p>
        </div>
        <RangeSelector value={range} onChange={setRange} />
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
              description={`错误分组 ${data.errors.groups.length} 类`}
            />
          </div>
          <Card>
            <CardHeader>
              <CardTitle>异常分组</CardTitle>
              <CardDescription>按 Provider、模型、状态、HTTP 与错误类型聚合</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>模型</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>HTTP</TableHead>
                    <TableHead>错误类型</TableHead>
                    <TableHead>最近错误</TableHead>
                    <TableHead>次数</TableHead>
                    <TableHead>最近发生</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.errors.groups.map((group) => (
                    <TableRow key={`${group.provider}-${group.model}-${group.status}-${group.httpStatus}-${group.errorType}`}>
                      <TableCell><ProviderBadge provider={group.provider} /></TableCell>
                      <TableCell className="max-w-48 truncate">{group.model ?? "—"}</TableCell>
                      <TableCell><StatusBadge status={group.status} /></TableCell>
                      <TableCell className="tabular-nums">{group.httpStatus ?? "—"}</TableCell>
                      <TableCell className="max-w-48 truncate">
                        {formatErrorType(group.errorType, language)}
                      </TableCell>
                      <TableCell className="max-w-64">
                        {group.lastErrorMessage === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="block truncate text-xs text-muted-foreground">
                                {group.lastErrorMessage}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-md">
                              <p className="break-words text-xs">
                                {group.lastErrorMessage}
                              </p>
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{group.requestCount}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {formatTime(group.lastOccurredAtMs)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {data.errors.groups.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="h-16 text-center text-muted-foreground">
                        没有异常请求
                      </TableCell>
                    </TableRow>
                  ) : null}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
