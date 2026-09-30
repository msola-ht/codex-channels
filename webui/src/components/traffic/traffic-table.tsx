import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
}: {
  exchanges: TrafficExchangeSummary[]
  onOpen: (exchange: TrafficExchangeSummary) => void
  loading?: boolean
  turnStates?: Map<string, Array<{ source: string; characters: number }>>
  turnStateErrors?: Map<string, string>
}) {
  const { t } = useTranslation()
  return (
    <div className="min-w-0">
      <Table className="min-w-[1040px]">
        <TableHeader>
          <TableRow>
            <TableHead>{t("metrics.time")}</TableHead>
            <TableHead>{t("metrics.provider")}</TableHead>
            <TableHead><TableHint hint={t("traffic.clientHint")}>{t("traffic.client")}</TableHint></TableHead>
            <TableHead>{t("metrics.model")}</TableHead>
            <TableHead>{t("traffic.protocol")}</TableHead>
            <TableHead>{t("filters.status")}</TableHead>
            <TableHead className="text-right whitespace-nowrap">
              <TableHint hint={t("traffic.firstTokenHint")}>{t("requests.firstColumn")}</TableHint>
            </TableHead>
            <TableHead className="text-right">{t("requests.durationColumn")}</TableHead>
            <TableHead className="text-right whitespace-nowrap">{t("traffic.turnStateColumn")}</TableHead>
            <TableHead>{t("metrics.type")}</TableHead>
            <TableHead>{t("metrics.requests")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? Array.from({ length: 5 }, (_, index) => (
            <TableRow key={index}>{Array.from({ length: 11 }, (_, column) => (
              <TableCell key={column}><Skeleton className="h-5 w-full min-w-12" /></TableCell>
            ))}</TableRow>
          )) : exchanges.map((exchange) => {
            const lengths = turnStates?.get(trafficCallKey(exchange))
            const turnStatesError = turnStateErrors?.get(trafficCallKey(exchange)) ?? null
            return (
            <TableRow
              key={`${exchange.label}:${exchange.session}:${exchange.id}`}
              className="cursor-pointer"
              onClick={() => onOpen(exchange)}
            >
              <TableCell className="whitespace-nowrap tabular-nums">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0"
                  aria-label={t("traffic.openDetailAria", { provider: exchange.label, time: formatTime(exchange.startedAtMs) })}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(exchange)
                  }}
                >{formatTime(exchange.startedAtMs)}</Button>
              </TableCell>
              <TableCell><Badge variant="outline">{["relay.chat", "relay.responses"].includes(exchange.label) ? exchange.account ?? exchange.label : exchange.label}</Badge></TableCell>
              <TableCell className="whitespace-nowrap">{exchange.clientName ?? "—"}</TableCell>
              <TableCell>
                <TrafficModel provider={["relay.chat", "relay.responses"].includes(exchange.label) ? exchange.account : exchange.label} request={exchange.requestModel} responses={exchange.responseModels} upstream={exchange.upstreamProvider} />
              </TableCell>
              <TableCell>{exchange.protocol ? <Badge variant="outline">{exchange.protocol === "chat" ? "Chat" : "Responses"}</Badge> : "—"}</TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                {exchange.status === undefined ? "" : `HTTP ${exchange.status} · `}
                {stateLabel(t, exchange.state)}
                {exchange.hasError ? <Badge className="ml-2" variant="destructive">{t("traffic.hasError")}</Badge> : null}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                {exchange.firstTokenMs == null ? "—" : formatElapsedDuration(exchange.firstTokenMs)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {exchange.durationMs === undefined ? "—" : formatElapsedDuration(exchange.durationMs)}
              </TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                <TableHint hint={turnStatesError !== null ? translateApiErrorCode(t, turnStatesError) : (!lengths?.length ? null : lengths.map((entry) => t("traffic.turnStateHint", { count: entry.characters.toLocaleString("zh-CN"), source: entry.source })).join("；"))}>
                  <span className="block max-w-40 truncate">{turnStatesError !== null ? t("common.loadFailed") : lengths === undefined ? t("common.loading") : lengths.length === 0 ? "—" : [...new Set(lengths.map((entry) => entry.characters))].map((count) => count.toLocaleString("zh-CN")).join(" / ")}</span>
                </TableHint>
              </TableCell>
              <TableCell className="text-xs">{exchange.category === "models" ? t("traffic.categoryModels")
                : exchange.category === "prewarm" ? t("traffic.categoryPrewarm") : exchange.requestKind ?? t("traffic.categoryRequest")}</TableCell>
              <TableCell><TruncatedText text={requestLabel(exchange)} className="max-w-72 font-mono text-xs" /></TableCell>
            </TableRow>
          )})}
          {!loading && exchanges.length === 0 ? (
            <TableRow>
              <TableCell colSpan={11} className="h-16 text-center text-muted-foreground">
                {t("traffic.empty")}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
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
