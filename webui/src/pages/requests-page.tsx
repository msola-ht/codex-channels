import { useState } from "react"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { useCurrency } from "@/hooks/currency-context"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { RangeSelector } from "@/components/metrics/range-selector"
import { StatusBadge } from "@/components/metrics/status-badge"
import { useRequests } from "@/hooks/use-requests"
import {
  formatCost,
  formatDuration,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { RangeName } from "@/lib/types"

export function RequestsPage() {
  const { currency } = useCurrency()
  const [range, setRange] = useState<RangeName>("24h")
  const [afterId, setAfterId] = useState<number | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const { data, loading, error } = useRequests(range, afterId, 100)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">请求明细</h1>
          <p className="text-sm text-muted-foreground">模型请求记录，按记录时间倒序分页</p>
        </div>
        <RangeSelector
          value={range}
          onChange={(next) => {
            setRange(next)
            setAfterId(null)
            setHistory([])
          }}
        />
      </div>

      <ErrorBanner error={error} />

      {loading || data === null ? <PageSkeleton rows={8} /> : (
        <Card>
          <CardHeader>
            <CardTitle>记录</CardTitle>
            <CardDescription>
              当前页 {data.records.length} 条
              {afterId === null ? "" : ` · 第 ${history.length + 1} 页`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>时间</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>操作</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead>HTTP</TableHead>
                  <TableHead>错误</TableHead>
                  <TableHead>输入 Token</TableHead>
                  <TableHead>输出 Token</TableHead>
                  <TableHead>TTFT</TableHead>
                  <TableHead>耗时</TableHead>
                  <TableHead>费用</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...data.records].reverse().map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {formatTime(record.recordedAtMs)}
                    </TableCell>
                    <TableCell><ProviderBadge provider={record.provider} /></TableCell>
                    <TableCell className="max-w-40 truncate">{record.model ?? "—"}</TableCell>
                    <TableCell>{record.operation === "compact" ? "压缩" : "响应"}</TableCell>
                    <TableCell><StatusBadge status={record.status} /></TableCell>
                    <TableCell className="tabular-nums">{record.httpStatus ?? "—"}</TableCell>
                    <TableCell className="max-w-40 truncate">
                      {record.errorType ?? record.errorCode ?? "—"}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatTokens(record.inputTokens)}</TableCell>
                    <TableCell className="tabular-nums">{formatTokens(record.outputTokens)}</TableCell>
                    <TableCell className="tabular-nums">{formatDuration(record.ttftMs)}</TableCell>
                    <TableCell className="tabular-nums">{formatDuration(record.requestDurationMs)}</TableCell>
                    <TableCell className="tabular-nums">{formatCost(record, currency)}</TableCell>
                  </TableRow>
                ))}
                {data.records.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="h-16 text-center text-muted-foreground">
                      暂无记录
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    aria-disabled={history.length === 0}
                    onClick={(event) => {
                      event.preventDefault()
                      if (history.length === 0) return
                      setAfterId(history[history.length - 1]!)
                      setHistory(history.slice(0, -1))
                    }}
                  />
                </PaginationItem>
                <PaginationItem>
                  <PaginationNext
                    aria-disabled={data.nextAfterId === null}
                    onClick={(event) => {
                      event.preventDefault()
                      if (data.nextAfterId !== null) {
                        if (afterId !== null) setHistory([...history, afterId])
                        setAfterId(data.nextAfterId)
                      }
                    }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
