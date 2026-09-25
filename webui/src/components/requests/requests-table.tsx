import * as React from "react"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { modelNameComparison } from "../../../../runtime/model-name-comparison.mjs"
import { trafficDetailPath } from "@/lib/traffic-state"
import type { SortingState } from "@tanstack/react-table"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { FastBadge } from "@/components/metrics/service-tier"
import { StatusBadge } from "@/components/metrics/status-badge"
import {
  DataTable,
  SortableHeader,
  TableHint,
  TruncatedText,
  type DataTableColumn,
} from "@/components/metrics/data-table"
import { useLanguage } from "@/hooks/language-context"
import {
  formatErrorMessage,
  formatElapsedDuration,
  formatErrorType,
  formatTime,
  formatTokens,
  formatTokensPerSecond,
} from "@/lib/format"
import type { RequestRecord } from "@/lib/types"

const TABLE_STATE_KEY = "codex-webui:requests-table-state-v4"

const COLUMN_LABELS: Record<string, string> = {
  time: "时间",
  provider: "Provider",
  model: "模型",
  ua: "User-Agent",
  operation: "操作",
  status: "状态",
  http: "HTTP",
  error: "错误",
  input: "输入 Token",
  output: "输出 Token",
  reasoningOutput: "推理输出",
  firstContent: "首字耗时",
  totalDuration: "总耗时",
  tokensPerSecond: "端到端 Token/s",
  generationTokensPerSecond: "生成 Token/s",
  traffic: "调用详情",
}

const DEFAULT_VISIBLE_COLUMNS: Record<string, boolean> = {
  ua: false,
  error: false,
  operation: false,
  http: false,
  reasoningOutput: false,
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500]

export function RequestsTable({
  loading = false,
  records,
  pageNumber,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  pageSize,
  onPageSizeChange,
  sorting,
  onSortingChange,
  onFilterChange,
  filter,
  total,
}: {
  loading?: boolean
  records: RequestRecord[]
  pageNumber: number
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  pageSize: number
  onPageSizeChange: (pageSize: number) => void
  sorting: SortingState
  onSortingChange: (sorting: SortingState) => void
  onFilterChange?: (filter: string) => void
  filter: string
  total: number
}) {
  const { language } = useLanguage()

  const columns = React.useMemo<DataTableColumn<RequestRecord>[]>(() => [
    {
      id: "time",
      accessorFn: (record) => record.recordedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>时间</SortableHeader>
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatTime(getValue<number>())}
        </span>
      ),
    },
    {
      id: "provider",
      accessorFn: (record) => record.provider ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>Provider</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (record) => record.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>模型</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          {modelNameComparison(row.original.requestModel, row.original.responseModel) !== "名称不一致"
            ? <TruncatedText text={row.original.requestModel ?? row.original.responseModel ?? row.original.model} className="max-w-64" />
            : <TableHint hint={`请求：${row.original.requestModel ?? "未知"}；响应回显：${row.original.responseModel ?? "未提供"}。仅比较名称，不验证模型身份。`}><span className="flex max-w-64 items-center gap-2 whitespace-nowrap">
            <span className="min-w-0 truncate">
              {modelNameComparison(row.original.requestModel, row.original.responseModel) === "名称不一致"
                ? `${row.original.requestModel} → ${row.original.responseModel}`
                : row.original.requestModel ?? row.original.responseModel ?? row.original.model ?? "—"}
            </span>
            {modelNameComparison(row.original.requestModel, row.original.responseModel) === "名称不一致"
              ? <Badge variant="outline">名称不一致</Badge> : null}
          </span></TableHint>}
          <FastBadge tier={row.original.requestServiceTier} source="request" responseTier={row.original.serviceTier} />
        </span>
      ),
    },
    {
      id: "status",
      accessorFn: (record) => record.status,
      header: ({ column }) => (
        <SortableHeader column={column}>状态</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        const badge = <StatusBadge status={record.status} />
        if (!record.errorMessage && !record.errorType && !record.errorCode) return badge
        const details = [
          formatErrorType(record.errorType ?? record.errorCode ?? null, language),
          ...(record.errorMessage ? [formatErrorMessage(record.errorMessage, language)] : []),
          ...(record.errorCode ? [`错误码：${record.errorCode}`] : []),
        ].join(" · ")
        return <TableHint hint={details}>{badge}</TableHint>
      },
    },
    {
      id: "input",
      accessorFn: (record) => record.inputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>输入 Token</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        if (record.cachedInputTokens === null && record.cacheHitRate === null) return <span className="tabular-nums">{formatTokens(record.inputTokens)}</span>
        const uncached =
          record.inputTokens === null || record.cachedInputTokens === null
            ? null
            : Math.max(0, record.inputTokens - record.cachedInputTokens)
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatTokens(record.inputTokens)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                <li className="whitespace-nowrap">
                  命中缓存：{formatTokens(record.cachedInputTokens)}
                </li>
                <li className="whitespace-nowrap">
                  未命中缓存：{uncached === null ? "—" : formatTokens(uncached)}
                </li>
                <li className="whitespace-nowrap">
                  命中率：
                  {record.cacheHitRate === null
                    ? "—"
                    : `${(record.cacheHitRate * 100).toFixed(1)}%`}
                </li>
              </ul>
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "output",
      accessorFn: (record) => record.outputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>输出 Token</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        if (record.reasoningOutputTokens === null) return <span className="tabular-nums">{formatTokens(record.outputTokens)}</span>
        const nonReasoning =
          record.outputTokens === null || record.reasoningOutputTokens === null
            ? null
            : Math.max(0, record.outputTokens - record.reasoningOutputTokens)
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatTokens(record.outputTokens)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                <li className="whitespace-nowrap">
                  推理输出：{formatTokens(record.reasoningOutputTokens)}
                </li>
                <li className="whitespace-nowrap">
                  非推理输出：{nonReasoning === null ? "—" : formatTokens(nonReasoning)}
                </li>
              </ul>
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "firstContent",
      accessorFn: (record) => record.firstContentMs,
      enableSorting: false,
      header: () => <TableHint hint="从开始转发到收到首个有效响应事件；不代表页面显示时间。">首字耗时</TableHint>,
      cell: ({ row }) => (
        <TableHint hint={row.original.upstreamTtftMs == null ? null : `上游轮次首 Token：${formatElapsedDuration(row.original.upstreamTtftMs)}`}><span className="tabular-nums">
          {row.original.firstContentMs == null ? "—"
            : formatElapsedDuration(row.original.firstContentMs)}
        </span></TableHint>
      ),
    },
    {
      id: "totalDuration",
      accessorFn: (record) => record.totalDurationMs,
      header: ({ column }) => <SortableHeader column={column} hint="从代理收到请求到模型完成或请求结束；不包含页面显示时间。">总耗时</SortableHeader>,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.totalDurationMs == null ? "—" : formatElapsedDuration(row.original.totalDurationMs)}</span>,
    },
    {
      id: "generationTokensPerSecond",
      accessorFn: (record) => record.generationTokensPerSecond,
      header: ({ column }) => <SortableHeader column={column} hint="输出 Token ÷ 首字之后的解码窗口，不含首字等待。">生成 Token/s</SortableHeader>,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{formatTokensPerSecond(row.original.generationTokensPerSecond)}</span>,
    },
    {
      id: "tokensPerSecond",
      accessorFn: (record) => record.tokensPerSecond,
      header: ({ column }) => <SortableHeader column={column} hint="输出 Token ÷ 请求总耗时，包含首字等待。">端到端 Token/s</SortableHeader>,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{formatTokensPerSecond(row.original.tokensPerSecond)}</span>,
    },
    {
      id: "traffic",
      header: "调用详情",
      enableSorting: false,
      cell: ({ row }) => row.original.traffic === null ? (
        <span className="text-muted-foreground">未关联</span>
      ) : (
        <Button variant="link" size="sm" asChild>
          <Link to={trafficDetailPath(row.original.traffic)}>查看调用详情</Link>
        </Button>
      ),
    },
    {
      id: "ua",
      accessorFn: (record) => record.userAgent ?? "",
      enableSorting: false,
      header: () => (
        <span className="-ml-2 inline-flex h-7 items-center px-1.5 text-muted-foreground">
          User-Agent
        </span>
      ),
      cell: ({ row }) => {
        const userAgent = row.original.userAgent
        if (!userAgent) return <span className="text-muted-foreground">—</span>
        return <TruncatedText text={userAgent} className="max-w-40 font-mono text-xs" />
      },
    },
    {
      id: "operation",
      accessorFn: (record) => (record.operation === "compact" ? "压缩" : "响应"),
      header: ({ column }) => (
        <SortableHeader column={column}>操作</SortableHeader>
      ),
      cell: ({ row }) =>
        row.original.operation === "compact" ? "压缩" : "响应",
    },
    {
      id: "http",
      accessorFn: (record) => record.httpStatus ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>HTTP</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.httpStatus ?? "—"}</span>
      ),
    },
    {
      id: "error",
      accessorFn: (record) => record.errorType ?? record.errorCode ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>错误</SortableHeader>
      ),
      cell: ({ row }) => {
        const label = formatErrorType(
          row.original.errorType ?? row.original.errorCode ?? null,
          language,
        )
        const message = row.original.errorMessage
        if (!message) {
          return <TruncatedText text={label} className="max-w-40" />
        }
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 block max-w-40 truncate">{label}</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-md">
              <p className="break-all whitespace-normal text-xs">{formatErrorMessage(message, language)}</p>
              {row.original.errorCode ? (
                <p className="mt-1 break-all whitespace-normal text-xs text-muted-foreground">
                  错误码：{row.original.errorCode}
                </p>
              ) : null}
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "reasoningOutput",
      accessorFn: (record) =>
        record.reasoningOutputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>推理输出</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.reasoningOutputTokens)}
        </span>
      ),
    },
  ], [language])

  return (
    <DataTable
      numericColumnIds={["input", "output", "firstContent", "totalDuration", "generationTokensPerSecond", "tokensPerSecond", "http", "reasoningOutput"]}
      loading={loading}
      title="记录"
      description={({ pageNumber: currentPage }) =>
        `共 ${total} 条匹配 · 当前页 ${records.length} 条 · 第 ${currentPage} 页`
      }
      columns={columns}
      data={records}
      storageKey={TABLE_STATE_KEY}
      columnLabels={COLUMN_LABELS}
      defaultColumnVisibility={DEFAULT_VISIBLE_COLUMNS}
      filterPlaceholder="筛选 Provider / 模型 / 状态 / 错误"
      filterHint="全库筛选"
      emptyText={filter.trim() === "" ? "暂无记录" : "无匹配记录"}
      noMatchText="无匹配记录"
      pagination={{
        mode: "server",
        pageNumber,
        pageSize,
        hasPrevious,
        hasNext,
        onPrevious,
        onNext,
        onPageSizeChange,
        pageSizeOptions: PAGE_SIZE_OPTIONS,
        sorting,
        onSortingChange,
        onFilterChange,
        serverTotal: total,
      }}
    />
  )
}
