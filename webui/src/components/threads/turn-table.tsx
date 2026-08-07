import * as React from "react"

import { Checkbox } from "@/components/ui/checkbox"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import {
  DataTable,
  SortableHeader,
  type DataTableColumn,
} from "@/components/metrics/data-table"
import { useCurrency } from "@/hooks/currency-context"
import {
  formatCost,
  formatCostDetail,
  formatSpeed,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { TurnSummary } from "@/lib/types"

const TABLE_STATE_KEY = "codex-webui:turns-table-state"

const COLUMN_LABELS: Record<string, string> = {
  time: "时间",
  provider: "Provider",
  model: "模型",
  requests: "请求",
  failures: "失败",
  input: "输入 Token",
  output: "输出 Token",
  speed: "速度",
  cost: "费用",
  compact: "压缩",
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

export function TurnTable({ turns }: { turns: TurnSummary[] }) {
  const { currency } = useCurrency()

  const columns = React.useMemo<DataTableColumn<TurnSummary>[]>(() => [
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
      accessorFn: (turn) => turn.recordedAtMs ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>时间</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatTime(row.original.recordedAtMs ?? null)}
        </span>
      ),
    },
    {
      id: "provider",
      accessorFn: (turn) => turn.provider ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>Provider</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (turn) => turn.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>模型</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="max-w-48 truncate">{row.original.model ?? "—"}</span>
      ),
    },
    {
      id: "requests",
      accessorFn: (turn) => turn.requestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>请求</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.requestCount}</span>
      ),
    },
    {
      id: "failures",
      accessorFn: (turn) => turn.unsuccessfulRequestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>失败</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.unsuccessfulRequestCount}
        </span>
      ),
    },
    {
      id: "input",
      accessorFn: (turn) => turn.inputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>输入 Token</SortableHeader>
      ),
      cell: ({ row }) => {
        const turn = row.original
        const uncached =
          turn.cachedInputTokens === null
            ? null
            : Math.max(0, turn.inputTokens - turn.cachedInputTokens)
        const rate =
          turn.inputTokens > 0 && turn.cachedInputTokens !== null
            ? turn.cachedInputTokens / turn.inputTokens
            : null
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatTokens(turn.inputTokens)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                <li className="whitespace-nowrap">
                  命中缓存：{formatTokens(turn.cachedInputTokens)}
                </li>
                <li className="whitespace-nowrap">
                  未命中缓存：{uncached === null ? "—" : formatTokens(uncached)}
                </li>
                <li className="whitespace-nowrap">
                  命中率：
                  {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
                </li>
              </ul>
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "output",
      accessorFn: (turn) => turn.outputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>输出 Token</SortableHeader>
      ),
      cell: ({ row }) => {
        const turn = row.original
        const nonReasoning = Math.max(
          0,
          turn.outputTokens - turn.reasoningOutputTokens,
        )
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatTokens(turn.outputTokens)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                <li className="whitespace-nowrap">
                  推理输出：{formatTokens(turn.reasoningOutputTokens)}
                </li>
                <li className="whitespace-nowrap">
                  非推理输出：{formatTokens(nonReasoning)}
                </li>
              </ul>
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "speed",
      accessorFn: (turn) =>
        turn.outputTokensPerSecond ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>速度</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatSpeed(row.original.outputTokensPerSecond)}
        </span>
      ),
    },
    {
      id: "cost",
      accessorFn: (turn) =>
        turn.totalCostCnyNanos ?? turn.totalCostNanos ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>费用</SortableHeader>
      ),
      cell: ({ row }) => {
        const turn = row.original
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatCost(turn, currency)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                {formatCostDetail(turn, currency).map((item) => (
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
    {
      id: "compact",
      accessorFn: (turn) => turn.compact?.requestCount ?? 0,
      header: ({ column }) => (
        <SortableHeader column={column}>压缩</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.compact === null
            ? "—"
            : `${row.original.compact.requestCount} 次`}
        </span>
      ),
    },
  ], [currency])

  return (
    <DataTable
      title="每轮明细"
      description={({ total, matched, pageSize }) =>
        `共 ${total} 轮 · 匹配 ${matched} 轮 · 每页 ${pageSize} 条`
      }
      columns={columns}
      data={turns}
      storageKey={TABLE_STATE_KEY}
      columnLabels={COLUMN_LABELS}
      filterPlaceholder="筛选 Provider / 模型 / 压缩"
      emptyText="暂无明细"
      noMatchText="无匹配记录"
      pagination={{
        mode: "client",
        defaultPageSize: 10,
        pageSizeOptions: PAGE_SIZE_OPTIONS,
        defaultSorting: [{ id: "time", desc: true }],
      }}
    />
  )
}
