import { useTranslation } from "@/hooks/use-translation"
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
  formatModelName,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { MetricsQuery, TurnSummary } from "@/lib/types"
import { metricsLink } from "@/lib/metrics-query"

const TABLE_STATE_KEY = "codex-webui:turns-table-state"

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

export function TurnTable({ turns, threadId, query, pagination, loading = false }: { turns: TurnSummary[]; threadId: string; query: MetricsQuery; pagination: DataTableProps<TurnSummary>["pagination"]; loading?: boolean }) {
  const { t } = useTranslation()
  const columnLabels: Record<string, string> = {
    turn: t("metrics.turn"),
    time: t("metrics.time"),
    provider: t("metrics.provider"),
    model: t("metrics.model"),
    requests: t("metrics.requests"),
    failures: t("metrics.failures"),
    input: t("metrics.input"),
    output: t("metrics.output"),
    compact: t("metrics.compact"),
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
      cell: ({ row }) => <TruncatedText asChild text={row.original.turnId} className="max-w-48"><Link className="underline-offset-4 hover:underline" to={metricsLink("/requests", query, { threadId, turnId: row.original.turnId })}>{row.original.turnId}</Link></TruncatedText>,
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
      accessorFn: (turn) => turn.unsuccessfulRequestCount,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.failures")}</SortableHeader>
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
        <SortableHeader column={column}>{t("metrics.input")}</SortableHeader>
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
                  {t("metrics.cached", { count: formatTokens(turn.cachedInputTokens) })}
                </li>
                <li className="whitespace-nowrap">
                  {t("metrics.uncached", { count: uncached === null ? "—" : formatTokens(uncached) })}
                </li>
                <li className="whitespace-nowrap">
                  {t("metrics.hitRate", { rate: rate === null ? "—" : `${(rate * 100).toFixed(1)}%` })}
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
        <SortableHeader column={column}>{t("metrics.output")}</SortableHeader>
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
  ], [threadId, query, t])

  return (
    <DataTable
      numericColumnIds={["requests", "failures", "input", "output", "compact"]}
      loading={loading}
      title={t("threads.turnList")}
      description={({ total, matched, pageSize }) =>
        t("threads.turnDescription", { total, matched, pageSize })
      }
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
