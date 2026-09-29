import * as React from "react"
import { Link, useLocation } from "react-router"
import { Button } from "@/components/ui/button"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { trafficDetailPath } from "@/lib/traffic-state"
import type { SortingState } from "@tanstack/react-table"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { FastBadge } from "@/components/metrics/service-tier"
import { StatusBadge } from "@/components/metrics/status-badge"
import {
  DataTable,
  SortableHeader,
  TableHint,
  TruncatedText,
  type DataTableColumn,
} from "@/components/metrics/data-table"
import { useTranslation } from "@/hooks/use-translation"
import {
  formatErrorMessage,
  formatElapsedDuration,
  formatErrorType,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { RequestRecord } from "@/lib/types"

const TABLE_STATE_KEY = "codex-webui:requests-table-state-v4"

const DEFAULT_VISIBLE_COLUMNS: Record<string, boolean> = {
  ua: false,
  error: false,
  operation: false,
  http: false,
  reasoningOutput: false,
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 200, 500]

export function RequestsTable({
  loading = false,
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
  filter,
  total,
}: {
  loading?: boolean
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
  filter: string
  total: number
}) {
  const { t, language } = useTranslation()
  const { search } = useLocation()
  const columnLabels: Record<string, string> = {
    source: t("filters.source"),
    caller: t("filters.caller"),
    delivery: t("filters.delivery"),
    time: t("metrics.time"),
    provider: t("metrics.provider"),
    model: t("metrics.model"),
    ua: "User-Agent",
    operation: t("filters.operation"),
    status: t("filters.status"),
    http: "HTTP",
    error: t("requests.errorColumn"),
    input: t("metrics.input"),
    cacheHitRate: t("metrics.cacheHitRate"),
    output: t("metrics.output"),
    reasoningOutput: t("requests.reasoningColumn"),
    firstContent: t("requests.firstColumn"),
    totalDuration: t("requests.durationColumn"),
    traffic: t("requestDetail.title"),
  }

  const columns = React.useMemo<DataTableColumn<RequestRecord>[]>(() => [
    {
      id: "source", enableSorting: false, header: t("filters.source"),
      cell: ({ row }) => row.original.source === "relay" ? t("filters.relay") : t("filters.owned"),
    },
    {
      id: "caller", enableSorting: false, header: t("filters.caller"),
      cell: ({ row }) => <TruncatedText text={row.original.callerId ?? "—"} className="max-w-40" />,
    },
    {
      id: "delivery", enableSorting: false, header: t("filters.delivery"),
      cell: ({ row }) => row.original.deliveryStatus === "finished" ? t("filters.deliveryFinished")
        : row.original.deliveryStatus === "disconnected" ? t("filters.deliveryDisconnected")
          : row.original.deliveryStatus === "failed" ? t("filters.deliveryFailed") : "—",
    },
    {
      id: "time",
      accessorFn: (record) => record.recordedAtMs,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.time")}</SortableHeader>
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
        <SortableHeader column={column}>{t("metrics.provider")}</SortableHeader>
      ),
      cell: ({ row }) => <ProviderBadge provider={row.original.provider} />,
    },
    {
      id: "model",
      accessorFn: (record) => record.model ?? "",
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.model")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          <TrafficModel
            provider={row.original.provider}
            request={row.original.requestModel}
            responses={row.original.responseModel === null || row.original.responseModel === undefined ? [] : [row.original.responseModel]}
            fallback={row.original.model ?? undefined}
            upstream={row.original.upstreamProvider}
          />
          <FastBadge tier={row.original.requestServiceTier} source="request" responseTier={row.original.serviceTier} />
        </span>
      ),
    },
    {
      id: "status",
      accessorFn: (record) => record.status,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("filters.status")}</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        const badge = <StatusBadge status={record.status} />
        if (!record.errorMessage && !record.errorType && !record.errorCode) return badge
        const details = [
          formatErrorType(record.errorType ?? record.errorCode ?? null, language),
          ...(record.errorMessage ? [formatErrorMessage(record.errorMessage, language)] : []),
          ...(record.errorCode ? [t("common.errorCode", { code: record.errorCode })] : []),
        ].join(" · ")
        return <TableHint hint={details}>{badge}</TableHint>
      },
    },
    {
      id: "input",
      accessorFn: (record) => record.inputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.input")}</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        if (record.cachedInputTokens === null && record.cacheHitRate === null) return <span className="tabular-nums">{formatTokens(record.inputTokens)}</span>
        const uncached =
          record.inputTokens === null || record.cachedInputTokens === null
            ? null
            : Math.max(0, record.inputTokens - record.cachedInputTokens)
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatTokens(record.inputTokens)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                <li className="whitespace-nowrap">
                  {t("metrics.cached", { count: formatTokens(record.cachedInputTokens) })}
                </li>
                <li className="whitespace-nowrap">
                  {t("metrics.uncached", { count: uncached === null ? "—" : formatTokens(uncached) })}
                </li>
                <li className="whitespace-nowrap">
                  {t("metrics.hitRate", {
                    rate: record.cacheHitRate === null
                      ? "—"
                      : `${(record.cacheHitRate * 100).toFixed(1)}%`,
                  })}
                </li>
              </ul>
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "cacheHitRate",
      enableSorting: false,
      header: t("metrics.cacheHitRate"),
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.cacheHitRate == null ? "—" : `${(row.original.cacheHitRate * 100).toFixed(1)}%`}</span>,
    },
    {
      id: "output",
      accessorFn: (record) => record.outputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("metrics.output")}</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        if (record.reasoningOutputTokens === null) return <span className="tabular-nums">{formatTokens(record.outputTokens)}</span>
        const nonReasoning =
          record.outputTokens === null || record.reasoningOutputTokens === null
            ? null
            : Math.max(0, record.outputTokens - record.reasoningOutputTokens)
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
                {formatTokens(record.outputTokens)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="right" align="start">
              <ul className="flex flex-col gap-1">
                <li className="whitespace-nowrap">
                  {t("metrics.reasoning", { count: formatTokens(record.reasoningOutputTokens) })}
                </li>
                <li className="whitespace-nowrap">
                  {t("metrics.nonReasoning", { count: nonReasoning === null ? "—" : formatTokens(nonReasoning) })}
                </li>
              </ul>
            </TooltipContent>
          </Tooltip>
        )
      },
    },
    {
      id: "firstContent",
      accessorFn: (record) => record.firstTokenMs,
      enableSorting: false,
      header: () => <TableHint hint={t("requests.firstHint")}>{t("requests.firstColumn")}</TableHint>,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.firstTokenMs == null ? "—"
            : formatElapsedDuration(row.original.firstTokenMs)}
        </span>
      ),
    },
    {
      id: "totalDuration",
      accessorFn: (record) => record.totalDurationMs,
      header: ({ column }) => <SortableHeader column={column} hint={t("requests.durationHint")}>{t("requests.durationColumn")}</SortableHeader>,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.totalDurationMs == null ? "—" : formatElapsedDuration(row.original.totalDurationMs)}</span>,
    },
    {
      id: "traffic", header: t("requestDetail.title"), enableSorting: false,
      cell: ({ row }) => <Button variant="link" size="sm" asChild>
        <Link to={row.original.traffic === null
          ? { pathname: `/requests/${row.original.id}`, search }
          : trafficDetailPath(row.original.traffic)}>{t("requestDetail.viewTraffic")}</Link>
      </Button>,
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
        return <TruncatedText text={userAgent} className="max-w-40 font-mono text-xs" />
      },
    },
    {
      id: "operation",
      accessorFn: (record) => record.operation,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("filters.operation")}</SortableHeader>
      ),
      cell: ({ row }) =>
        row.original.operation === "compact" ? t("metrics.compact") : t("filters.response"),
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
        <SortableHeader column={column}>{t("requests.errorColumn")}</SortableHeader>
      ),
      cell: ({ row }) => {
        const label = formatErrorType(
          row.original.errorType ?? row.original.errorCode ?? null,
          language,
        )
        const message = row.original.errorMessage
        if (!message) {
          return <TruncatedText text={label} className="max-w-40" />
        }
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 block max-w-40 truncate">{label}</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-md">
              <p className="break-all whitespace-normal text-xs">{formatErrorMessage(message, language)}</p>
              {row.original.errorCode ? (
                <p className="mt-1 break-all whitespace-normal text-xs text-muted-foreground">
                  {t("common.errorCode", { code: row.original.errorCode })}
                </p>
              ) : null}
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
        <SortableHeader column={column}>{t("requests.reasoningColumn")}</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatTokens(row.original.reasoningOutputTokens)}
        </span>
      ),
    },
  ], [t, language, search])

  return (
    <DataTable
      numericColumnIds={["input", "cacheHitRate", "output", "firstContent", "totalDuration", "http", "reasoningOutput"]}
      loading={loading}
      title={t("requests.tableTitle")}
      description={() => t("requests.tableDescription", { total, count: records.length, page: pageNumber })}
      columns={columns}
      data={records}
      storageKey={TABLE_STATE_KEY}
      columnLabels={columnLabels}
      defaultColumnVisibility={DEFAULT_VISIBLE_COLUMNS}
      emptyText={filter.trim() === "" ? t("common.empty") : t("common.noMatch")}
      noMatchText={t("common.noMatch")}
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
        serverTotal: total,
      }}
    />
  )
}
