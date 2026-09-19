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
import { useLanguage } from "@/hooks/language-context"
import {
  formatErrorMessage,
  formatElapsedDuration,
  formatErrorType,
  formatTime,
  formatTokens,
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
}

const DEFAULT_VISIBLE_COLUMNS: Record<string, boolean> = {
  operation: false,
  http: false,
  reasoningOutput: false,
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
  filter,
  total,
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
  onFilterChange?: (filter: string) => void
  filter: string
  total: number
}) {
  const { language } = useLanguage()

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
      id: "firstContent",
      accessorFn: (record) => record.firstContentMs,
      enableSorting: false,
      header: "首字耗时",
      cell: ({ row }) => (
        <span className="tabular-nums" title={`上游转发开始至首个符合条件的事件：HTTP 为跳过 created/in_progress 的首个 Responses 语义事件；WS 为 delta 或 output_text/function_call_arguments.done。不要求文本非空，不计纯错误或旁路元数据；不是客户端显示时间。上游轮次首 Token：${row.original.upstreamTtftMs == null ? "未提供" : formatElapsedDuration(row.original.upstreamTtftMs)}`}>
          {row.original.firstContentMs == null ? "—"
            : formatElapsedDuration(row.original.firstContentMs)}
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
        <span className="max-w-64 truncate" title={`请求：${row.original.requestModel ?? "未知"}；响应回显：${row.original.responseModel ?? "未提供"}。仅比较名称，不验证模型身份。`}>
          {row.original.requestModel && row.original.responseModel && row.original.requestModel !== row.original.responseModel
            ? `${row.original.requestModel} → ${row.original.responseModel}`
            : row.original.model ?? "—"}
        </span>
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
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block max-w-40 truncate font-mono text-xs">{userAgent}</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-md">
              <p className="break-all text-xs">{userAgent}</p>
            </TooltipContent>
          </Tooltip>
        )
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
      cell: ({ row }) => {
        const label = formatErrorType(
          row.original.errorType ?? row.original.errorCode ?? null,
          language,
        )
        const message = row.original.errorMessage
        if (!message) {
          return <span className="max-w-40 truncate">{label}</span>
        }
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="max-w-40 truncate">{label}</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-md">
              <p className="break-words text-xs">{formatErrorMessage(message, language)}</p>
              {row.original.errorCode ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  错误码：{row.original.errorCode}
                </p>
              ) : null}
            </TooltipContent>
          </Tooltip>
        )
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
  ], [language])

  return (
    <DataTable
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
