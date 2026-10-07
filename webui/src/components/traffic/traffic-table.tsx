import { Badge } from "@/components/ui/badge"
import { formatGenerationSpeed } from "../../../../runtime/request-timing.mjs"
import { Button } from "@/components/ui/button"
import { DataTable, TableHint, TruncatedText, type DataTableColumn, type DataTableProps } from "@/components/metrics/data-table"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { formatRequestTime, requestMethodDisplay, formatTimestamp, getServerTimeZone, formatElapsedDuration } from "@/lib/format"
import type { TrafficExchangeSummary } from "@/lib/types"
import type { Translate } from "@/lib/i18n/messages"
import { trafficCallKey } from "@/lib/traffic-state"
import { useTranslation } from "@/hooks/use-translation"

export function TrafficTable({
  exchanges,
  onOpen,
  loading = false,
  pagination,
  description,
}: {
  exchanges: TrafficExchangeSummary[]
  onOpen: (exchange: TrafficExchangeSummary) => void
  pagination: DataTableProps<TrafficExchangeSummary>["pagination"]
  description: string
  loading?: boolean
}) {
  const { t } = useTranslation()
  const columns: DataTableColumn<TrafficExchangeSummary>[] = [
    { id: "requestPurpose", enableSorting: false, header: t("requestMethod.label"), cell: ({ row }) => {
      const method = requestMethodDisplay(row.original, t)
      return <Badge variant={method.variant}>{method.label}</Badge>
    } },
    { id: "time", enableSorting: false, enableHiding: false, header: () => <>{t("traffic.startedAt")}</>, cell: ({ row: { original: exchange } }) => {
      return <><Button
                  type="button"
                  variant="link"
                  title={`${formatTimestamp(exchange.startedAtMs)} · ${getServerTimeZone()}`}
                  size="sm"
                  className="h-auto border-0 px-0"
                  aria-label={t("traffic.openDetailAria", { provider: exchange.label, time: formatRequestTime(exchange.startedAtMs) })}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(exchange)
                  }}
                >{formatRequestTime(exchange.startedAtMs)}</Button></>
    } },
    { id: "provider", enableSorting: false, header: () => <>{t("metrics.provider")}</>, cell: ({ row: { original: exchange } }) => {
      return <><Badge variant="outline">{["relay.chat", "relay.responses"].includes(exchange.label) ? exchange.account ?? exchange.label : exchange.label}</Badge></>
    } },
    { id: "client", enableSorting: false, header: () => <><TableHint hint={t("traffic.clientHint")}>{t("traffic.client")}</TableHint></>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.clientName ?? "—"}</>
    } },
    { id: "model", enableSorting: false, header: () => <>{t("metrics.model")}</>, cell: ({ row: { original: exchange } }) => {
      return <><TrafficModel provider={["relay.chat", "relay.responses"].includes(exchange.label) ? exchange.account : exchange.label} request={exchange.requestModel} responses={exchange.responseModels} upstream={exchange.upstreamProvider} /></>
    } },
    { id: "reasoningEffort", enableSorting: false, header: t("metrics.reasoningEffort"), cell: ({ row }) => row.original.reasoningEffort ?? "—" },
    { id: "protocol", enableSorting: false, header: () => <>{t("traffic.protocol")}</>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.protocol ? <Badge variant="outline">{exchange.protocol === "chat" ? "Chat" : "Responses"}</Badge> : "—"}</>
    } },
    { id: "status", enableSorting: false, header: () => <>{t("filters.status")}</>, cell: ({ row: { original: exchange } }) => {
      return <>{stateLabel(t, exchange.state)}</>
    } },
    { id: "first", enableSorting: false, header: () => <><TableHint hint={t("requests.firstHint")}>{t("requests.firstColumn")}</TableHint></>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.firstTokenMs == null ? "—" : formatElapsedDuration(exchange.firstTokenMs)}</>
    } },
    { id: "generationSpeed", enableSorting: false, header: () => <TableHint hint={t("requests.speedHint")}>{t("requests.speedColumn")}</TableHint>, cell: ({ row: { original: exchange } }) => {
      return <>{formatGenerationSpeed({ ...exchange, status: exchange.state, totalDurationMs: exchange.durationMs })}</>
    } },
    { id: "duration", enableSorting: false, header: t("requests.durationColumn"), cell: ({ row: { original: exchange } }) => {
      return <>{exchange.durationMs == null ? "—" : formatElapsedDuration(exchange.durationMs)}</>
    } },
    { id: "type", enableSorting: false, header: () => <>{t("metrics.type")}</>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.category === "models" ? t("traffic.categoryModels")
                : exchange.category === "prewarm" ? t("traffic.categoryPrewarm") : exchange.requestKind ?? t("traffic.categoryRequest")}</>
    } },
    { id: "request", enableSorting: false, header: () => <>{t("metrics.requests")}</>, cell: ({ row: { original: exchange } }) => {
      return <><TruncatedText text={requestLabel(exchange)} className="max-w-72 font-mono text-xs" /></>
    } },
    { id: "detail", enableSorting: false, enableHiding: false, header: t("requests.detailColumn"), cell: ({ row: { original: exchange } }) => (
      <Button variant="link" size="sm" className="border-0 px-0" aria-label={t("traffic.openDetailAria", { provider: exchange.label, time: formatRequestTime(exchange.startedAtMs) })}
        onClick={(event) => { event.stopPropagation(); onOpen(exchange) }}>{t("requests.viewDetail")}</Button>
    ) },
  ]
  const order = ["time", "provider", "requestPurpose", "model", "reasoningEffort", "status", "first", "generationSpeed", "duration", "client", "protocol", "type", "request", "detail"]
  const orderedColumns = [...columns].sort((a, b) => order.indexOf(a.id!) - order.indexOf(b.id!))
  return <DataTable title={t("traffic.listTitle", { count: pagination.mode === "server" ? pagination.serverTotal ?? exchanges.length : exchanges.length })}
    description={() => description} data={exchanges} columns={orderedColumns} loading={loading}
    storageKey="codex-webui:traffic-table-v2" defaultColumnVisibility={{ request: false }} getRowId={trafficCallKey} onRowClick={onOpen}
    columnLabels={{requestPurpose: t("requestMethod.label"), time: t("traffic.startedAt"), provider: t("metrics.provider"), client: t("traffic.client"), model: t("metrics.model"), reasoningEffort: t("metrics.reasoningEffort"), protocol: t("traffic.protocol"), status: t("filters.status"), first: t("requests.firstColumn"), generationSpeed: t("requests.speedColumn"), duration: t("requests.durationColumn"), type: t("metrics.type"), request: t("metrics.requests"), detail: t("requests.detailColumn")}}
    numericColumnIds={["first", "generationSpeed", "duration"]} emptyText={t("traffic.empty")} pagination={pagination} />
}

function stateLabel(t: Translate, state: TrafficExchangeSummary["state"]): string {
  if (state === "completed") return t("traffic.stateCompleted")
  if (state === "failed") return t("traffic.stateFailed")
  if (state === "incomplete") return t("traffic.stateIncomplete")
  return t("traffic.statePending")
}

function requestLabel(exchange: TrafficExchangeSummary): string {
  if (exchange.transport === "websocket") {
    return exchange.url === undefined ? "WebSocket" : `WS ${exchange.url}`
  }
  if (exchange.method === undefined && exchange.path === undefined) return "—"
  return `${exchange.method ?? ""} ${exchange.path ?? ""}`
}
