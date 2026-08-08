import * as React from "react"

import { Link } from "react-router"

import {
  DataTable,
  SortableHeader,
  type DataTableColumn,
} from "@/components/metrics/data-table"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { Badge } from "@/components/ui/badge"
import { useCurrency } from "@/hooks/currency-context"
import {
  formatCost,
  formatTime,
  formatTokens,
  shortThreadId,
} from "@/lib/format"
import type { ThreadListItem } from "@/lib/types"

const TABLE_STATE_KEY = "codex-webui:threads-table-state-v1"

const COLUMN_LABELS: Record<string, string> = {
  time: "开始时间",
  thread: "Thread",
  provider: "Provider",
  model: "模型",
  type: "类型",
  parent: "父会话",
  turns: "Turn",
  requests: "请求",
  input: "输入 Token",
  output: "输出 Token",
  cost: "费用",
  compact: "压缩",
  last: "最后记录",
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200]

export function ThreadTable({ threads }: { threads: ThreadListItem[] }) {
  const { currency } = useCurrency()
  const mainCount = threads.filter((thread) => thread.agentPath === null).length
  const subagentCount = threads.length - mainCount

  const columns = React.useMemo<DataTableColumn<ThreadListItem>[]>(() => [
    {
      id: "time",
      accessorFn: (thread) => thread.firstRequestStartedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>开始时间</SortableHeader>
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatTime(getValue<number>())}
        </span>
      ),
    },
    {
      id: "thread",
      accessorFn: (thread) => thread.threadId,
      header: ({ column }) => (
        <SortableHeader column={column}>Thread</SortableHeader>
      ),
      cell: ({ row }) => (
        <Link
          to={`/threads/${row.original.threadId}`}
          className="font-medium underline-offset-4 hover:underline"
          title={row.original.threadId}
        >
          {shortThreadId(row.original.threadId)}
        </Link>
      ),
    },
    {
      id: "provider",
      accessorFn: (thread) => thread.provider ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>Provider</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (thread) => thread.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>模型</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="max-w-40 truncate">{row.original.model ?? "—"}</span>
      ),
    },
    {
      id: "type",
      accessorFn: (thread) =>
        thread.agentPath === null ? "主会话" : `子代理 ${thread.agentPath}`,
      header: ({ column }) => (
        <SortableHeader column={column}>类型</SortableHeader>
      ),
      cell: ({ row }) =>
        row.original.agentPath === null ? (
          <span className="text-muted-foreground">主会话</span>
        ) : (
          <Badge
            variant="secondary"
            className="max-w-64 justify-start"
            title={row.original.agentPath}
          >
            <span className="truncate">子代理 · {row.original.agentPath}</span>
          </Badge>
        ),
    },
    {
      id: "parent",
      accessorFn: (thread) => thread.parentThreadId ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>父会话</SortableHeader>
      ),
      cell: ({ row }) =>
        row.original.parentThreadId === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Link
            to={`/threads/${row.original.parentThreadId}`}
            className="underline-offset-4 hover:underline"
            title={row.original.parentThreadId}
          >
            {shortThreadId(row.original.parentThreadId)}
          </Link>
        ),
    },
    {
      id: "turns",
      accessorFn: (thread) => thread.turnCount,
      header: ({ column }) => (
        <SortableHeader column={column}>Turn</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.turnCount}</span>
      ),
    },
    {
      id: "requests",
      accessorFn: (thread) => thread.requestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>请求</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.requestCount}</span>
      ),
    },
    {
      id: "input",
      accessorFn: (thread) => thread.inputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>输入 Token</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.inputTokens)}
        </span>
      ),
    },
    {
      id: "output",
      accessorFn: (thread) => thread.outputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>输出 Token</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.outputTokens)}
        </span>
      ),
    },
    {
      id: "cost",
      accessorFn: (thread) =>
        thread.totalCostCnyNanos ?? thread.totalCostNanos ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>费用</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{formatCost(row.original, currency)}</span>
      ),
    },
    {
      id: "compact",
      accessorFn: (thread) => thread.compact?.requestCount ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>压缩</SortableHeader>
      ),
      cell: ({ row }) =>
        row.original.compact === null
          ? "—"
          : `${row.original.compact.requestCount} 次`,
    },
    {
      id: "last",
      accessorFn: (thread) => thread.lastRecordedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>最后记录</SortableHeader>
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatTime(getValue<number>())}
        </span>
      ),
    },
  ], [currency])

  return (
    <DataTable
      title="会话列表"
      description={({ total, matched }) =>
        `共 ${total} 个会话（主会话 ${mainCount} · 子代理 ${subagentCount}）· 匹配 ${matched} 条`
      }
      columns={columns}
      data={threads}
      storageKey={TABLE_STATE_KEY}
      columnLabels={COLUMN_LABELS}
      filterPlaceholder="筛选 Thread / 类型 / 路径 / 模型"
      filterHint="全库筛选"
      emptyText="暂无会话记录"
      noMatchText="无匹配会话"
      pagination={{
        mode: "client",
        defaultPageSize: 50,
        pageSizeOptions: PAGE_SIZE_OPTIONS,
        defaultSorting: [{ id: "last", desc: true }],
      }}
    />
  )
}
