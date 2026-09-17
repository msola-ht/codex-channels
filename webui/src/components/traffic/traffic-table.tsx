import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatTime } from "@/lib/format"
import type { TrafficExchangeSummary } from "@/lib/types"

export function TrafficTable({
  exchanges,
  selectedId,
  detailAnchorId,
  onSelect,
}: {
  exchanges: TrafficExchangeSummary[]
  selectedId: number | null
  detailAnchorId: string
  onSelect: (id: number) => void
}) {
  return (
    <div className="overflow-x-auto">
      <Table className="min-w-[960px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>时间</TableHead>
            <TableHead>请求</TableHead>
            <TableHead>线程</TableHead>
            <TableHead>轮次</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>模型</TableHead>
            <TableHead>状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {exchanges.map((exchange) => (
            <TableRow
              key={exchange.id}
              data-state={exchange.id === selectedId ? "selected" : undefined}
              className="cursor-pointer"
              onClick={() => onSelect(exchange.id)}
            >
              <TableCell className="tabular-nums">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 font-mono"
                  aria-controls={detailAnchorId}
                  aria-expanded={exchange.id === selectedId}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSelect(exchange.id)
                  }}
                >#{exchange.id}</Button>
              </TableCell>
              <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                {formatTime(exchange.startedAtMs)}
              </TableCell>
              <TableCell className="max-w-72 truncate font-mono text-xs">
                {requestLabel(exchange)}
              </TableCell>
              <TableCell className="max-w-40 truncate font-mono text-xs" title={exchange.threadId}>
                {exchange.threadId ?? "—"}
              </TableCell>
              <TableCell className="max-w-32 truncate font-mono text-xs" title={exchange.turnId}>
                {exchange.turnId ?? "—"}
              </TableCell>
              <TableCell className="text-xs">{exchange.requestKind ?? "—"}</TableCell>
              <TableCell className="max-w-56 truncate text-xs">
                {exchange.requestModel ?? "—"} → {exchange.responseModels.join("、") || "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                {exchange.status ?? "—"}
                {exchange.hasError ? <Badge className="ml-2" variant="destructive">中断</Badge> : null}
              </TableCell>
            </TableRow>
          ))}
          {exchanges.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="h-16 text-center text-muted-foreground">
                没有转储记录
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </div>
  )
}

function requestLabel(exchange: TrafficExchangeSummary): string {
  if (exchange.transport === "websocket") {
    return exchange.url === undefined ? "WebSocket" : `WS ${exchange.url}`
  }
  if (exchange.method === undefined && exchange.path === undefined) return "—"
  return `${exchange.method ?? ""} ${exchange.path ?? ""}`
}
