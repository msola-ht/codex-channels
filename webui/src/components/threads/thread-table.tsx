import { useTranslation } from "@/hooks/use-translation"
import * as React from "react"

import { Link } from "react-router"

import {
  DataTable,
  SortableHeader,
  TableHint,
  TruncatedText,
  type DataTableColumn,
  type DataTableProps,
} from "@/components/metrics/data-table"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import {
  formatCacheUsage,
  formatElapsedDuration,
  formatModelName,
  formatTime,
  formatTokens,
  shortThreadId,
} from "@/lib/format"
import type { MetricsQuery, ThreadListItem } from "@/lib/types"
import { metricsLink } from "@/lib/metrics-query"

const TABLE_STATE_KEY = "codex-webui:threads-table-state-v1"

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200]

export function ThreadTable({ threads, query, pagination, loading = false }: { threads: ThreadListItem[]; query: MetricsQuery; pagination: DataTableProps<ThreadListItem>["pagination"]; loading?: boolean }) {
  const { t } = useTranslation()
  const columnLabels: Record<string, string> = {
    time: t("metrics.first"),
    thread: t("metrics.thread"),
    provider: t("metrics.provider"),
    model: t("metrics.model"),
    turns: t("metrics.turn"),
    requests: t("metrics.requests"),
    input: t("metrics.input"),
    cacheHitRate: t("metrics.cacheHitRate"),
    output: t("metrics.output"),
    compact: t("metrics.compact"),
    last: t("metrics.last"),
    subagents: t("threads.directSubagents"),
    duration: t("threads.totalDuration"),
  }

  const columns = React.useMemo<DataTableColumn<ThreadListItem>[]>(() => [
    {
      id: "time",
      accessorFn: (thread) => thread.firstRequestStartedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.first")}</SortableHeader>
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
        <SortableHeader column={column}>{t("metrics.thread")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <Link
          to={metricsLink(`/threads/${encodeURIComponent(row.original.threadId)}`, query, { threadId: undefined })}
          className="font-medium underline-offset-4 hover:underline"
          title={shortThreadId(row.original.threadId) === row.original.threadId ? undefined : row.original.threadId}
        >
          {shortThreadId(row.original.threadId)}
        </Link>
      ),
    },
    {
      id: "provider",
      accessorFn: (thread) => thread.provider ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.provider")}</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (thread) => thread.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.model")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <TruncatedText text={formatModelName(row.original.model, row.original.provider)} className="max-w-40" />
      ),
    },
    {
      id: "turns",
      accessorFn: (thread) => thread.turnCount,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.turn")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.turnCount}</span>
      ),
    },
    {
      id: "requests",
      accessorFn: (thread) => thread.requestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.requests")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.requestCount}</span>
      ),
    },
    {
      id: "input",
      accessorFn: (thread) => thread.inputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.input")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.inputTokens)}
        </span>
      ),
    },
    {
      id: "duration",
      enableSorting: false,
      header: () => <TableHint hint={t("threads.totalDurationHint")}>{t("threads.totalDuration")}</TableHint>,
      cell: ({ row }) => {
        const timing = row.original.sessionTiming
        if (timing.knownDurationMs === null) return "—"
        const partial = !timing.historyComplete || timing.missingTurnCount > 0
        const notes = [
          ...(partial ? [t("threads.knownDuration")] : []),
          ...(timing.missingTurnCount > 0 ? [t("threads.missingDurations", { count: timing.missingTurnCount })] : []),
          ...(!timing.historyComplete ? [t("threads.durationHistoryIncomplete")] : []),
          t("threads.totalDurationHint"),
        ].join(" ")
        return <TableHint hint={notes}><span className="tabular-nums">{formatElapsedDuration(timing.knownDurationMs)}{partial ? " *" : ""}</span></TableHint>
      },
    },
    {
      id: "cacheHitRate",
      enableSorting: false,
      header: t("metrics.cacheHitRate"),
      cell: ({ row }) => (
        <span className="whitespace-nowrap tabular-nums">
          {formatCacheUsage(row.original.cacheUsage).rate}
        </span>
      ),
    },
    {
      id: "output",
      accessorFn: (thread) => thread.outputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.output")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.outputTokens)}
        </span>
      ),
    },
    {
      id: "last",
      accessorFn: (thread) => thread.lastRecordedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.last")}</SortableHeader>
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatTime(getValue<number>())}
        </span>
      ),
    },
    {
      id: "subagents",
      header: () => <TableHint hint={t("threads.subagentCountHint")}>{t("threads.directSubagents")}</TableHint>,
      enableSorting: false,
      enableHiding: false,
      cell: ({ row }) => row.original.directSubagentCount > 0 ? <Link
        to={`/threads/${encodeURIComponent(row.original.threadId)}/subagents`}
        className="tabular-nums hover:underline"
        aria-label={t("threads.subagentsForThread", { id: shortThreadId(row.original.threadId), count: row.original.directSubagentCount })}
      >{row.original.directSubagentCount}</Link> : <span className="tabular-nums">0</span>,
    },
    {
      id: "compact",
      accessorFn: (thread) => thread.compact?.requestCount ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.compact")}</SortableHeader>
      ),
      cell: ({ row }) =>
        row.original.compact === null
          ? "—"
          : t("metrics.times", { count: row.original.compact.requestCount }),
    },
  ], [query, t])

  return (
    <DataTable
      numericColumnIds={["turns", "requests", "input", "cacheHitRate", "output", "compact", "subagents"]}
      loading={loading}
      title={t("threads.list")}
      description={({ total }) =>
        t("threads.description", { total })
      }
      columns={columns}
      data={threads}
      getRowId={(thread) => thread.threadId}
      storageKey={TABLE_STATE_KEY}
      columnLabels={columnLabels}
      defaultColumnVisibility={{ compact: false }}
      emptyText={t("threads.empty")}
      noMatchText={t("threads.noMatch")}
      pagination={{ ...pagination, pageSizeOptions: PAGE_SIZE_OPTIONS }}
    />
  )
}
