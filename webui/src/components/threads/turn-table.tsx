import { useTranslation } from "@/hooks/use-translation"
import * as React from "react"
import { Link } from "react-router"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { InputTokenTooltip } from "@/components/metrics/token-tooltip"
import {
  DataTable,
  SortableHeader,
  TableHint,
  TruncatedText,
  type DataTableColumn,
  type DataTableProps,
} from "@/components/metrics/data-table"
import {
  formatModelName,
  formatInterruptionSummary,
  formatInterruptedUsage,
  formatElapsedDuration,
  formatTime,
  formatTokens,
  shortThreadId,
} from "@/lib/format"
import type { MetricsQuery, ThreadTurnsResponse } from "@/lib/types"
import { metricsLink } from "@/lib/metrics-query"

const TABLE_STATE_KEY = "codex-webui:turns-table-state"
type TurnSummary = ThreadTurnsResponse["turns"][number]

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

export function TurnTable({ turns, threadId, query, pagination, loading = false }: { turns: TurnSummary[]; threadId: string; query: MetricsQuery; pagination: DataTableProps<TurnSummary>["pagination"]; loading?: boolean }) {
  const { t } = useTranslation()
  const columnLabels: Record<string, string> = {
    turn: t("metrics.turn"),
    duration: t("threads.turnDuration"),
    time: t("metrics.time"),
    provider: t("metrics.provider"),
    model: t("metrics.model"),
    requests: t("metrics.requests"),
    failures: t("metrics.failures"),
    interrupted: t("metrics.interrupted"),
    incomplete: t("metrics.incompleteObservation"),
    input: t("metrics.input"),
    cacheHitRate: t("metrics.cacheHitRate"),
    output: t("metrics.output"),
    compact: t("metrics.compact"),
    subagents: t("threads.directSubagents"),
  }
  const columns = React.useMemo<DataTableColumn<TurnSummary>[]>(() => [
    {
      id: "time",
      accessorFn: (turn) => turn.recordedAtMs ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.time")}</SortableHeader>
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
      header: ({ column }) => <SortableHeader column={column}>{t("metrics.turn")}</SortableHeader>,
      cell: ({ row }) => {
        const turnId = row.original.turnId
        const label = shortThreadId(turnId)
        const link = <Link className="underline-offset-4 hover:underline" to={metricsLink("/requests", query, { threadId, turnId })}>{label}</Link>
        return label === turnId ? link : <Tooltip>
          <TooltipTrigger aria-description={turnId} render={link} />
          <TooltipContent>{turnId}</TooltipContent>
        </Tooltip>
      },
    },
    {
      id: "provider",
      accessorFn: (turn) => turn.provider ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.provider")}</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (turn) => turn.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.model")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <TruncatedText text={formatModelName(row.original.model, row.original.provider)} className="max-w-48" />
      ),
    },
    {
      id: "requests",
      accessorFn: (turn) => turn.requestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.requests")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.requestCount}</span>
      ),
    },
    {
      id: "failures",
      accessorFn: (turn) => turn.requestOutcomes.failed,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.failures")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.requestOutcomes.failed}
        </span>
      ),
    },
    {
      id: "input",
      accessorFn: (turn) => turn.inputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.input")}</SortableHeader>
      ),
      cell: ({ row }) => row.original.interruptionSummary.usageUnobserved > 0
        ? <TableHint hint={formatInterruptionSummary(row.original.interruptionSummary, t)}>{formatInterruptedUsage(row.original.inputTokens, row.original.interruptionSummary)}</TableHint>
        : <InputTokenTooltip inputTokens={row.original.inputTokens} cachedInputTokens={row.original.cachedInputTokens} />,
    },
    {
      id: "cacheHitRate",
      enableSorting: false,
      header: t("metrics.cacheHitRate"),
      cell: ({ row }) => {
        const turn = row.original
        if (turn.interruptionSummary.usageUnobserved > 0) return "—"
        return <span className="whitespace-nowrap tabular-nums">{turn.inputTokens > 0 && turn.cachedInputTokens !== null
          ? `${(turn.cachedInputTokens / turn.inputTokens * 100).toFixed(1)}%`
          : "—"}</span>
      },
    },
    {
      id: "output",
      accessorFn: (turn) => turn.outputTokens,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.output")}</SortableHeader>
      ),
      cell: ({ row }) => {
        const turn = row.original
        if (turn.interruptionSummary.usageUnobserved > 0) return <TableHint hint={formatInterruptionSummary(turn.interruptionSummary, t)}>{formatInterruptedUsage(turn.outputTokens, turn.interruptionSummary)}</TableHint>
        const nonReasoning = Math.max(
          0,
          turn.outputTokens - turn.reasoningOutputTokens,
        )
        return (
          <Tooltip>
            <TooltipTrigger aria-description={[t("metrics.reasoning", { count: formatTokens(turn.reasoningOutputTokens) }), t("metrics.nonReasoning", { count: nonReasoning === null ? "—" : formatTokens(nonReasoning) })].join("; ")} render={<span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2" />}>
                {formatTokens(turn.outputTokens)}
              </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                <li className="whitespace-nowrap">
                  {t("metrics.reasoning", { count: formatTokens(turn.reasoningOutputTokens) })}
                </li>
                <li className="whitespace-nowrap">
                  {t("metrics.nonReasoning", { count: formatTokens(nonReasoning) })}
                </li>
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
        <SortableHeader column={column}>{t("metrics.compact")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.compact === null
            ? "—"
            : t("metrics.times", { count: row.original.compact.requestCount })}
        </span>
      ),
    },
    {
      id: "interrupted",
      enableSorting: false,
      accessorFn: (turn) => turn.requestOutcomes.interrupted,
      header: t("metrics.interrupted"),
      cell: ({ row }) => <TableHint hint={row.original.requestOutcomes.interrupted > 0 ? formatInterruptionSummary(row.original.interruptionSummary, t) : null}>
        <span className="tabular-nums">{row.original.requestOutcomes.interrupted}</span>
      </TableHint>,
    },
    {
      id: "incomplete",
      enableSorting: false,
      accessorFn: (turn) => turn.requestOutcomes.incomplete,
      header: t("metrics.incompleteObservation"),
      cell: ({ row }) => <span className="tabular-nums">{row.original.requestOutcomes.incomplete}</span>,
    },
    {
      id: "duration",
      enableSorting: false,
      header: () => t("threads.turnDuration"),
      cell: ({ row }) => row.original.durationMs == null ? "—" : formatElapsedDuration(row.original.durationMs),
    },
    {
      id: "subagents",
      enableSorting: false,
      enableHiding: false,
      header: () => <TableHint hint={t("threads.turnSubagentsHint")}>{t("threads.directSubagents")}</TableHint>,
      cell: ({ row }) => row.original.directSubagentCount > 0 ? <Link
        to={`/threads/${encodeURIComponent(threadId)}/subagents?parentTurnId=${encodeURIComponent(row.original.turnId)}`}
        className="tabular-nums hover:underline"
        aria-label={t("threads.subagentsForTurn", { id: shortThreadId(row.original.turnId), count: row.original.directSubagentCount })}
      >{row.original.directSubagentCount}</Link> : <span className="tabular-nums">0</span>,
    },
  ], [threadId, query, t])

  return (
    <DataTable
      numericColumnIds={["requests", "failures", "interrupted", "incomplete", "input", "cacheHitRate", "output", "compact", "duration", "subagents"]}
      loading={loading}
      title={t("threads.turnList")}
      description={({ matched }) => <TableHint hint={t("threads.turnHint")}>{t("threads.turnDescription", { matched })}</TableHint>}
      columns={columns}
      data={turns}
      storageKey={TABLE_STATE_KEY}
      columnLabels={columnLabels}
      defaultColumnVisibility={{ compact: false }}
      filterPlaceholder={t("threads.turnFilter")}
      emptyText={t("threads.turnEmpty")}
      noMatchText={t("common.noMatch")}
      pagination={{ ...pagination, pageSizeOptions: PAGE_SIZE_OPTIONS }}
    />
  )
}
