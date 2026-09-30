import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, TableHint, TruncatedText, type DataTableColumn, type DataTableProps } from "@/components/metrics/data-table"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { formatTime, formatElapsedDuration } from "@/lib/format"
import type { TrafficExchangeSummary } from "@/lib/types"
import type { Translate } from "@/lib/i18n/messages"
import { trafficCallKey } from "@/lib/traffic-state"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { useTranslation } from "@/hooks/use-translation"

export function TrafficTable({
  exchanges,
  onOpen,
  loading = false,
  turnStates,
  turnStateErrors,
  pagination,
  description,
}: {
  exchanges: TrafficExchangeSummary[]
  onOpen: (exchange: TrafficExchangeSummary) => void
  pagination: DataTableProps<TrafficExchangeSummary>["pagination"]
  description: string
  loading?: boolean
  turnStates?: Map<string, Array<{ source: string; characters: number }>>
  turnStateErrors?: Map<string, string>
}) {
  const { t } = useTranslation()
  const columns: DataTableColumn<TrafficExchangeSummary>[] = [
    { id: "time", enableSorting: false, header: () => <>{t("metrics.time")}</>, cell: ({ row: { original: exchange } }) => {
      return <><Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  aria-label={t("traffic.openDetailAria", { provider: exchange.label, time: formatTime(exchange.startedAtMs) })}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(exchange)
                  }}
                >{formatTime(exchange.startedAtMs)}</Button></>
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
    { id: "protocol", enableSorting: false, header: () => <>{t("traffic.protocol")}</>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.protocol ? <Badge variant="outline">{exchange.protocol === "chat" ? "Chat" : "Responses"}</Badge> : "—"}</>
    } },
    { id: "status", enableSorting: false, header: () => <>{t("filters.status")}</>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.status === undefined ? "" : `HTTP ${exchange.status} · `}
                {stateLabel(t, exchange.state)}
                {exchange.hasError ? <Badge className="ml-2" variant="destructive">{t("traffic.hasError")}</Badge> : null}</>
    } },
    { id: "first", enableSorting: false, header: () => <><TableHint hint={t("traffic.firstTokenHint")}>{t("requests.firstColumn")}</TableHint></>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.firstTokenMs == null ? "—" : formatElapsedDuration(exchange.firstTokenMs)}</>
    } },
    { id: "duration", enableSorting: false, header: () => <>{t("requests.durationColumn")}</>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.durationMs === undefined ? "—" : formatElapsedDuration(exchange.durationMs)}</>
    } },
    { id: "turnState", enableSorting: false, header: () => <>{t("traffic.turnStateColumn")}</>, cell: ({ row: { original: exchange } }) => {
      const lengths = turnStates?.get(trafficCallKey(exchange))
      const turnStatesError = turnStateErrors?.get(trafficCallKey(exchange)) ?? null
      return <><TableHint hint={turnStatesError !== null ? translateApiErrorCode(t, turnStatesError) : (!lengths?.length ? null : lengths.map((entry) => t("traffic.turnStateHint", { count: entry.characters.toLocaleString("zh-CN"), source: entry.source })).join("；"))}>
                  <span className="block max-w-40 truncate">{turnStatesError !== null ? t("common.loadFailed") : lengths === undefined ? t("common.loading") : lengths.length === 0 ? "—" : [...new Set(lengths.map((entry) => entry.characters))].map((count) => count.toLocaleString("zh-CN")).join(" / ")}</span>
                </TableHint></>
    } },
    { id: "type", enableSorting: false, header: () => <>{t("metrics.type")}</>, cell: ({ row: { original: exchange } }) => {
      return <>{exchange.category === "models" ? t("traffic.categoryModels")
                : exchange.category === "prewarm" ? t("traffic.categoryPrewarm") : exchange.requestKind ?? t("traffic.categoryRequest")}</>
    } },
    { id: "request", enableSorting: false, header: () => <>{t("metrics.requests")}</>, cell: ({ row: { original: exchange } }) => {
      return <><TruncatedText text={requestLabel(exchange)} className="max-w-72 font-mono text-xs" /></>
    } },
  ]
  return <DataTable title={t("traffic.listTitle", { count: pagination.mode === "server" ? pagination.serverTotal ?? exchanges.length : exchanges.length })}
    description={() => description} data={exchanges} columns={columns} loading={loading}
    storageKey="codex-webui:traffic-table-v1" getRowId={trafficCallKey} onRowClick={onOpen}
    columnLabels={{time: t("metrics.time"), provider: t("metrics.provider"), client: t("traffic.client"), model: t("metrics.model"), protocol: t("traffic.protocol"), status: t("filters.status"), first: t("requests.firstColumn"), duration: t("requests.durationColumn"), turnState: t("traffic.turnStateColumn"), type: t("metrics.type"), request: t("metrics.requests")}}
    numericColumnIds={["first", "duration", "turnState"]} emptyText={t("traffic.empty")} pagination={pagination} />
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
