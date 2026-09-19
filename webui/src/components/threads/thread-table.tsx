import * as React from "react"

import { Link } from "react-router"

import {
  DataTable,
  SortableHeader,
  TableHint,
  type DataTableColumn,
  type DataTableProps,
} from "@/components/metrics/data-table"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { Badge } from "@/components/ui/badge"
import {
  formatTime,
  formatTokens,
  formatTokensPerSecond,
  shortThreadId,
} from "@/lib/format"
import type { MetricsQuery, ThreadListItem } from "@/lib/types"
import { metricsLink } from "@/lib/metrics-query"

const TABLE_STATE_KEY = "codex-webui:threads-table-state-v1"

const COLUMN_LABELS: Record<string, string> = {
  time: "期间首次请求",
  thread: "Thread",
  provider: "Provider",
  model: "模型",
  type: "类型",
  parent: "父会话",
  turns: "Turn",
  requests: "请求",
  input: "输入 Token",
  output: "输出 Token",
  tokensPerSecond: "平均 Token/s",
  compact: "压缩",
  last: "最后记录",
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200]

export function ThreadTable({ threads, query, pagination, loading = false }: { threads: ThreadListItem[]; query: MetricsQuery; pagination: DataTableProps<ThreadListItem>["pagination"]; loading?: boolean }) {
  const mainCount = threads.filter((thread) => thread.agentPath === null).length
  const subagentCount = threads.length - mainCount

  const columns = React.useMemo<DataTableColumn<ThreadListItem>[]>(() => [
    {
      id: "time",
      accessorFn: (thread) => thread.firstRequestStartedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>期间首次请求</SortableHeader>
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
          to={metricsLink(`/threads/${encodeURIComponent(row.original.threadId)}`, query, { threadId: undefined })}
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
        <TableHint hint={row.original.model ?? "未提供模型名称"}><span className="block max-w-40 truncate">{row.original.model ?? "—"}</span></TableHint>
      ),
    },
    {
      id: "type",
      enableSorting: false,
      accessorFn: (thread) =>
        thread.agentPath === null ? "主会话" : `子代理 ${thread.agentPath}`,
      header: "类型",
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
      id: "tokensPerSecond",
      accessorFn: (thread) => thread.tokensPerSecond,
      header: ({ column }) => <SortableHeader column={column}>平均 Token/s</SortableHeader>,
      cell: ({ row }) => <TableHint hint="当前筛选范围内，各有效请求 Token/s 的算术平均；仅统计该会话自身。"><span className="whitespace-nowrap tabular-nums">{formatTokensPerSecond(row.original.tokensPerSecond)}</span></TableHint>,
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
    {
      id: "parent",
      enableSorting: false,
      accessorFn: (thread) => thread.parentThreadId ?? "",
      header: "父会话",
      cell: ({ row }) =>
        row.original.parentThreadId === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <Link
            to={metricsLink(`/threads/${encodeURIComponent(row.original.parentThreadId)}`, query, { threadId: undefined, turnId: undefined })}
            className="underline-offset-4 hover:underline"
            title={row.original.parentThreadId}
          >
            {shortThreadId(row.original.parentThreadId)}
          </Link>
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
  ], [query])

  return (
    <DataTable
      numericColumnIds={["turns", "requests", "input", "output", "tokensPerSecond", "compact"]}
      loading={loading}
      title="会话列表"
      description={({ total }) =>
        `共 ${total} 个匹配会话 · 本页主会话 ${mainCount} / 子代理 ${subagentCount} · 各会话只统计自身请求`
      }
      columns={columns}
      data={threads}
      storageKey={TABLE_STATE_KEY}
      columnLabels={COLUMN_LABELS}
      defaultColumnVisibility={{ parent: false, compact: false }}
      emptyText="暂无会话记录"
      noMatchText="无匹配会话"
      pagination={{ ...pagination, pageSizeOptions: PAGE_SIZE_OPTIONS }}
    />
  )
}
