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
import { InputTokenTooltip } from "@/components/metrics/token-tooltip"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
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

function ThreadTokenTotal({ thread }: { thread: ThreadListItem }) {
  const { t } = useTranslation()
  const usage = thread.subagentUsage
  const cached = usage.cachedInputTokens === null && usage.cacheUsage.cachedInputTokens !== null
    ? `≥ ${formatTokens(usage.cacheUsage.cachedInputTokens)}`
    : formatTokens(usage.cachedInputTokens)
  const rows = [
    [t("threads.tokenInput"), formatTokens(usage.inputTokens)],
    [t("threads.tokenCached"), cached],
    [t("metrics.cacheHitRate"), formatCacheUsage(usage.cacheUsage).rate],
    [t("threads.tokenOutput"), formatTokens(usage.outputTokens)],
    [t("threads.tokenSubtotal"), formatTokens(usage.inputTokens + usage.outputTokens)],
  ]
  const total = formatTokens(thread.totalTokens)
  const description = `${t("threads.tokenSubagents")}: ${rows.map(([label, value]) => `${label}: ${value}`).join(", ")}. ${t("threads.totalTokens")}: ${total}`

  return (
    <Tooltip>
      <TooltipTrigger aria-description={description} render={<span tabIndex={0} className="inline-flex cursor-help tabular-nums focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>
        {total}
      </TooltipTrigger>
      <TooltipContent>
        <div className="flex flex-col gap-2">
          <span>{t("threads.tokenSubagents")}:</span>
          <dl className="flex flex-col gap-1 ps-2">
            {rows.map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt>{label}:</dt>
                <dd className="tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <Separator />
          <dl>
            <div className="flex justify-between gap-4">
              <dt>{t("threads.totalTokens")}:</dt>
              <dd className="tabular-nums">{total}</dd>
            </div>
          </dl>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

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
    totalTokens: t("threads.totalTokens"),
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
      header: ({ column }) => <SortableHeader column={column}>{t("metrics.input")}</SortableHeader>,
      cell: ({ row }) => <InputTokenTooltip inputTokens={row.original.inputTokens} cachedInputTokens={row.original.cachedInputTokens} cacheUsage={row.original.cacheUsage} />,
    },
    {
      id: "cacheHitRate",
      enableSorting: false,
      header: t("metrics.cacheHitRate"),
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{formatCacheUsage(row.original.cacheUsage).rate}</span>,
    },
    {
      id: "output",
      accessorFn: (thread) => thread.outputTokens,
      header: ({ column }) => <SortableHeader column={column}>{t("metrics.output")}</SortableHeader>,
      cell: ({ row }) => <span className="tabular-nums">{formatTokens(row.original.outputTokens)}</span>,
    },
    {
      id: "totalTokens",
      accessorFn: (thread) => thread.totalTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("threads.totalTokens")}</SortableHeader>
      ),
      cell: ({ row }) => <ThreadTokenTotal thread={row.original} />,
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
      numericColumnIds={["turns", "requests", "input", "cacheHitRate", "output", "totalTokens", "compact", "subagents"]}
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
