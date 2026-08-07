import * as React from "react"
import type { SortingState } from "@tanstack/react-table"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Checkbox } from "@/components/ui/checkbox"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { StatusBadge } from "@/components/metrics/status-badge"
import {
  DataTable,
  SortableHeader,
  type DataTableColumn,
} from "@/components/metrics/data-table"
import { useCurrency } from "@/hooks/currency-context"
import {
  formatCost,
  formatCostDetail,
  formatDuration,
  formatSpeed,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { RequestRecord } from "@/lib/types"

const TABLE_STATE_KEY = "codex-webui:requests-table-state-v2"

const COLUMN_LABELS: Record<string, string> = {
  time: "时间",
  provider: "Provider",
  model: "模型",
  operation: "操作",
  status: "状态",
  http: "HTTP",
  error: "错误",
  input: "输入 Token",
  output: "输出 Token",
  reasoningOutput: "推理输出",
  speed: "输出速度",
  ttft: "TTFT",
  duration: "耗时",
  cost: "费用",
}

const DEFAULT_VISIBLE_COLUMNS: Record<string, boolean> = {
  operation: false,
  http: false,
  error: false,
  reasoningOutput: false,
  ttft: false,
  duration: false,
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500]

export function RequestsTable({
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
}: {
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
  onFilterChange?: () => void
}) {
  const { currency } = useCurrency()

  const columns = React.useMemo<DataTableColumn<RequestRecord>[]>(() => [
    {
      id: "select",
      header: ({ table }) => (
        <Checkbox
          checked={
            table.getIsAllPageRowsSelected() ||
            (table.getIsSomePageRowsSelected() && "indeterminate")
          }
          onCheckedChange={() => table.toggleAllPageRowsSelected()}
          aria-label="选择全部行"
        />
      ),
      cell: ({ row }) => (
        <Checkbox
          checked={row.getIsSelected()}
          onCheckedChange={() => row.toggleSelected()}
          aria-label="选择行"
        />
      ),
      enableSorting: false,
      enableHiding: false,
    },
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
        <span className="max-w-40 truncate">{row.original.model ?? "—"}</span>
      ),
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
      id: "status",
      accessorFn: (record) => record.status,
      header: ({ column }) => (
        <SortableHeader column={column}>状态</SortableHeader>
      ),
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
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
      cell: ({ row }) => (
        <span className="max-w-40 truncate">
          {row.original.errorType ?? row.original.errorCode ?? "—"}
        </span>
      ),
    },
    {
      id: "input",
      accessorFn: (record) => record.inputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>输入 Token</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        const uncached =
          record.inputTokens === null || record.cachedInputTokens === null
            ? null
            : Math.max(0, record.inputTokens - record.cachedInputTokens)
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
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
        const nonReasoning =
          record.outputTokens === null || record.reasoningOutputTokens === null
            ? null
            : Math.max(0, record.outputTokens - record.reasoningOutputTokens)
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
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
    {
      id: "speed",
      accessorFn: (record) =>
        record.outputTokensPerSecond ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>输出速度</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatSpeed(row.original.outputTokensPerSecond)}
        </span>
      ),
    },
    {
      id: "ttft",
      accessorFn: (record) => record.ttftMs ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>TTFT</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatDuration(row.original.ttftMs)}
        </span>
      ),
    },
    {
      id: "duration",
      accessorFn: (record) =>
        record.requestDurationMs ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>耗时</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatDuration(row.original.requestDurationMs)}
        </span>
      ),
    },
    {
      id: "cost",
      accessorFn: (record) =>
        record.totalCostCnyNanos ?? record.totalCostNanos ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>费用</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatCost(record, currency)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                {formatCostDetail(record, currency).map((item) => (
                  <li key={item.label} className="whitespace-nowrap">
                    {item.label}：{item.value}
                  </li>
                ))}
              </ul>
            </TooltipContent>
          </Tooltip>
        )
      },
    },
  ], [currency])

  return (
    <DataTable
      title="记录"
      description={({ pageNumber: currentPage }) =>
        `当前页 ${records.length} 条 · 第 ${currentPage} 页 · 排序作用于全部记录`
      }
      columns={columns}
      data={records}
      storageKey={TABLE_STATE_KEY}
      columnLabels={COLUMN_LABELS}
      defaultColumnVisibility={DEFAULT_VISIBLE_COLUMNS}
      filterPlaceholder="筛选 Provider / 模型 / 状态 / 错误"
      filterHint="仅当前已加载页"
      emptyText="暂无记录"
      noMatchText="当前页无匹配记录"
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
      }}
    />
  )
}
