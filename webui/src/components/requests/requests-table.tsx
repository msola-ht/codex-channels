import * as React from "react"
import { formatGenerationSpeed } from "../../../../runtime/request-timing.mjs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { RequestDetail } from "@/components/requests/request-detail"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { SortingState } from "@tanstack/react-table"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { FastBadge } from "@/components/metrics/service-tier"
import { InputTokenTooltip, OutputTokenTooltip } from "@/components/metrics/token-tooltip"
import { StatusBadge } from "@/components/metrics/status-badge"
import { RelayRequestStatus } from "@/components/requests/relay-request-status"
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
  isClientInterruption,
  formatElapsedDuration,
  formatErrorType,
  formatRequestTime,
  requestMethodDisplay,
  formatTimestamp,
  getServerTimeZone,
  formatTokens,
} from "@/lib/format"
import type { RequestRecord } from "@/lib/types"

const TABLE_STATE_KEY = "codex-webui:requests-table-state-v5"

const DEFAULT_VISIBLE_COLUMNS: Record<string, boolean> = {
  caller: false,
  delivery: false,
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
  const [selected, setSelected] = React.useState<RequestRecord | null>(null)
  const currentSelected = selected === null ? null : records.find(record => record.id === selected.id) ?? selected
  if (currentSelected !== selected) setSelected(currentSelected)
  const opener = React.useRef<HTMLElement | null>(null)
  const openRequest = React.useCallback((record: RequestRecord, trigger?: HTMLElement) => {
    opener.current = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    setSelected(record)
  }, [])
  const columnLabels: Record<string, string> = {
    source: t("filters.source"),
    requestPurpose: t("requestMethod.label"),
    caller: t("filters.caller"),
    delivery: t("filters.delivery"),
    time: t("requests.recordedAt"),
    provider: t("metrics.provider"),
    model: t("metrics.model"),
    reasoningEffort: t("metrics.reasoningEffort"),
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
    generationSpeed: t("requests.speedColumn"),
    duration: t("requests.durationColumn"),
    traffic: t("requests.detailColumn"),
  }

  const columns = React.useMemo<DataTableColumn<RequestRecord>[]>(() => [
    {
      id: "requestPurpose", enableSorting: false, header: t("requestMethod.label"),
      cell: ({ row }) => {
        const method = requestMethodDisplay(row.original, t)
        return <Badge variant={method.variant}>{method.label}</Badge>
      },
    },
    {
      id: "source", enableSorting: false, header: t("filters.source"),
      cell: ({ row }) => <div className="flex flex-col gap-1">
        <span>{row.original.source === "relay" ? t("filters.relay") : t("filters.owned")}</span>
        <TruncatedText text={row.original.callerDisplayName ?? row.original.callerId ?? ""} className="max-w-40 text-muted-foreground" />
      </div>,
    },
    {
      id: "caller", enableSorting: false, header: t("filters.caller"),
      cell: ({ row }) => row.original.callerDisplayName ? <TableHint hint={`${row.original.callerDisplayName}\n${row.original.callerId}`}>
        <span className="block max-w-40 truncate">{row.original.callerDisplayName}</span>
      </TableHint> : <TruncatedText text={row.original.callerId ?? "—"} className="max-w-40" />,
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
        <SortableHeader column={column}>{t("requests.recordedAt")}</SortableHeader>
      ),
      cell: ({ getValue }) => (
        <span className="tabular-nums text-muted-foreground" title={`${formatTimestamp(getValue<number>())} · ${getServerTimeZone()}`}>
          {formatRequestTime(getValue<number>())}
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
            upstream={row.original.upstreamProvider}
            request={row.original.requestModel}
            responses={row.original.responseModel === null || row.original.responseModel === undefined ? [] : [row.original.responseModel]}
            fallback={row.original.model ?? undefined}
          />
          {(row.original.upstreamAttemptCount ?? 0) > 1 ? <Badge variant="secondary" size="sm"
            title={t("requestDetail.attemptHint")}>{t("requestDetail.attemptBadge", { count: row.original.upstreamAttemptCount! })}</Badge> : null}
          <FastBadge tier={row.original.requestServiceTier} source="request" responseTier={row.original.serviceTier} />
        </span>
      ),
    },
    {
      id: "reasoningEffort",
      enableSorting: false,
      header: t("metrics.reasoningEffort"),
      cell: ({ row }) => row.original.reasoningEffort ?? "—",
    },
    {
      id: "status",
      accessorFn: (record) => record.status,
      header: ({ column }) => (
        <SortableHeader column={column}>{t("filters.status")}</SortableHeader>
      ),
      cell: ({ row }) => {
        const record = row.original
        if (record.source === "relay") return <div className="flex flex-col gap-1"><RelayRequestStatus key={record.relayRequestId ?? record.id} record={record} />
          {record.deliveryStatus == null ? null : <span className="text-xs text-muted-foreground">{t("requestDetail.deliverySummary", { value: record.deliveryStatus === "finished" ? t("filters.deliveryFinished") : record.deliveryStatus === "disconnected" ? t("filters.deliveryDisconnected") : t("filters.deliveryFailed") })}</span>}
        </div>
        const badge = isClientInterruption(record) ? <Badge variant="secondary">{t("metrics.interrupted")}</Badge> : <StatusBadge status={record.status} />
        if (isClientInterruption(record)) return <TableHint hint={t("metrics.clientInterruption")}>{badge}</TableHint>
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
        <SortableHeader column={column} hint={t("metrics.input")}>{t("metrics.inputColumn")}</SortableHeader>
      ),
      cell: ({ row }) => <InputTokenTooltip inputTokens={row.original.inputTokens} cachedInputTokens={row.original.cachedInputTokens} />,
    },
    {
      id: "cacheHitRate",
      enableSorting: false,
      header: () => <TableHint hint={t("metrics.cacheHitRate")}>{t("metrics.cacheHitRateColumn")}</TableHint>,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.cacheHitRate == null ? "—" : `${(row.original.cacheHitRate * 100).toFixed(1)}%`}</span>,
    },
    {
      id: "output",
      accessorFn: (record) => record.outputTokens ?? Number.NEGATIVE_INFINITY,
      header: ({ column }) => (
        <SortableHeader column={column} hint={t("metrics.output")}>{t("metrics.outputColumn")}</SortableHeader>
      ),
      cell: ({ row }) => <OutputTokenTooltip outputTokens={row.original.outputTokens} reasoningOutputTokens={row.original.reasoningOutputTokens} />,
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
      id: "generationSpeed",
      enableSorting: false,
      header: () => <TableHint hint={t("requests.speedHint")}>{t("requests.speedColumn")}</TableHint>,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{formatGenerationSpeed(row.original)}</span>,
    },
    {
      id: "duration", enableSorting: false,
      header: t("requests.durationColumn"),
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{row.original.totalDurationMs == null ? "—" : formatElapsedDuration(row.original.totalDurationMs)}</span>,
    },
    {
      id: "traffic", header: t("requests.detailColumn"), enableSorting: false, enableHiding: false,
      cell: ({ row }) => <Button variant="link" size="sm" className="border-0 px-0" aria-label={t("requestDetail.open")} onClick={(event) => {
        event.stopPropagation()
        openRequest(row.original, event.currentTarget)
      }}>{t("requests.viewDetail")}</Button>,
    },
    {
      id: "ua",
      accessorFn: (record) => record.userAgent ?? "",
      enableSorting: false,
      header: "User-Agent",
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
        if (isClientInterruption(row.original)) return <TruncatedText text={t("metrics.clientInterruption")} className="max-w-40" />
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
            <TooltipTrigger aria-description={[formatErrorMessage(message, language), row.original.errorCode ? t("common.errorCode", { code: row.original.errorCode }) : null].filter(Boolean).join("; ")} render={<span tabIndex={0} className="focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 block max-w-40 truncate" />}>{label}</TooltipTrigger>
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
  ], [t, language, openRequest])

  const order = ["time", "provider", "requestPurpose", "model", "reasoningEffort", "status", "input", "cacheHitRate", "output", "reasoningOutput", "firstContent", "generationSpeed", "duration", "source", "caller", "delivery", "ua", "operation", "http", "error", "traffic"]
  const orderedColumns = [...columns].sort((a, b) => (order.includes(a.id!) ? order.indexOf(a.id!) : order.length) - (order.includes(b.id!) ? order.indexOf(b.id!) : order.length))

  return (
    <>
    <DataTable
      numericColumnIds={["input", "cacheHitRate", "output", "firstContent", "generationSpeed", "duration", "http", "reasoningOutput"]}
      loading={loading}
      title={t("requests.tableTitle")}
      description={() => t("requests.tableDescription", { total, count: records.length, page: pageNumber })}
      columns={orderedColumns}
      getRowId={(record) => String(record.id)}
      onRowClick={openRequest}
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
    <Sheet open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null) }}>
      <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl overflow-y-auto" closeLabel={t("common.close")}
        finalFocus={() => opener.current?.isConnected ? opener.current : true}>
        <SheetHeader><SheetTitle>{t("requestDetail.title")}</SheetTitle><SheetDescription>{t("requestDetail.description")}</SheetDescription></SheetHeader>
        <div className="px-4 pb-4">{currentSelected === null ? null : <RequestDetail record={currentSelected} />}</div>
      </SheetContent>
    </Sheet>
    </>
  )
}
