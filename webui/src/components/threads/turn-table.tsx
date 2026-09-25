import * as React from "react"
import { Link } from "react-router"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import {
  DataTable,
  SortableHeader,
  TruncatedText,
  type DataTableColumn,
  type DataTableProps,
} from "@/components/metrics/data-table"
import {
  formatTime,
  formatTokens,
  formatTokensPerSecond,
} from "@/lib/format"
import type { MetricsQuery, TurnSummary } from "@/lib/types"
import { metricsLink } from "@/lib/metrics-query"

const TABLE_STATE_KEY = "codex-webui:turns-table-state"

const COLUMN_LABELS: Record<string, string> = {
  turn: "Turn",
  time: "时间",
  provider: "Provider",
  model: "模型",
  requests: "请求",
  failures: "失败",
  input: "输入 Token",
  output: "输出 Token",
  generationTokensPerSecond: "生成 Token/s",
  compact: "压缩",
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

export function TurnTable({ turns, threadId, query, pagination, loading = false }: { turns: TurnSummary[]; threadId: string; query: MetricsQuery; pagination: DataTableProps<TurnSummary>["pagination"]; loading?: boolean }) {
  const columns = React.useMemo<DataTableColumn<TurnSummary>[]>(() => [
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
      id: "turn",
      accessorFn: (turn) => turn.turnId,
      header: ({ column }) => <SortableHeader column={column}>Turn</SortableHeader>,
      cell: ({ row }) => <TruncatedText asChild text={row.original.turnId} className="max-w-48"><Link className="underline-offset-4 hover:underline" to={metricsLink("/requests", query, { threadId, turnId: row.original.turnId })}>{row.original.turnId}</Link></TruncatedText>,
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
        <TruncatedText text={row.original.model} className="max-w-48" />
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
        if (turn.cachedInputTokens === null) return <span className="tabular-nums">{formatTokens(turn.inputTokens)}</span>
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
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
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
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
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
      id: "generationTokensPerSecond",
      accessorFn: (turn) => turn.generationTokensPerSecond,
      header: ({ column }) => <SortableHeader column={column} hint="该轮有效请求合计输出除以合计解码窗口（总耗时减去首字耗时）。">生成 Token/s</SortableHeader>,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{formatTokensPerSecond(row.original.generationTokensPerSecond)}</span>,
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
  ], [threadId, query])

  return (
    <DataTable
      numericColumnIds={["requests", "failures", "input", "output", "generationTokensPerSecond", "compact"]}
      loading={loading}
      title="每轮明细"
      description={({ total, matched, pageSize }) =>
        `共 ${total} 轮 · 匹配 ${matched} 轮 · 每页 ${pageSize} 条`
      }
      columns={columns}
      data={turns}
      storageKey={TABLE_STATE_KEY}
      columnLabels={COLUMN_LABELS}
      defaultColumnVisibility={{ compact: false }}
      filterPlaceholder="筛选 Provider / 模型 / 压缩"
      emptyText="暂无明细"
      noMatchText="无匹配记录"
      pagination={{ ...pagination, pageSizeOptions: PAGE_SIZE_OPTIONS }}
    />
  )
}
