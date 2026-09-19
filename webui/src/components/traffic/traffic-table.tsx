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
import { formatTime, formatElapsedDuration } from "@/lib/format"
import type { TrafficExchangeSummary } from "@/lib/types"

export function TrafficTable({
  exchanges,
  onOpen,
}: {
  exchanges: TrafficExchangeSummary[]
  onOpen: (exchange: TrafficExchangeSummary) => void
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
              key={`${exchange.session}:${exchange.id}`}
              className="cursor-pointer"
              onClick={() => onOpen(exchange)}
            >
              <TableCell className="tabular-nums">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto px-0 font-mono"
                  aria-label={`查看批次 ${exchange.session} 的模型调用 #${exchange.id} 明细`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(exchange)
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
              <TableCell className="text-xs">{exchange.category === "models" ? "模型列表"
                : exchange.category === "prewarm" ? "连接预热" : exchange.requestKind ?? "模型请求"}</TableCell>
              <TableCell className="max-w-56 truncate text-xs">
                {exchange.requestModel ?? "—"} → {exchange.responseModels.join("、") || "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                {exchange.status === undefined ? "" : `HTTP ${exchange.status} · `}
                {stateLabel(exchange.state)}
                {exchange.durationMs === undefined ? "" : ` · ${formatElapsedDuration(exchange.durationMs)}`}
                {exchange.hasError ? <Badge className="ml-2" variant="destructive">异常</Badge> : null}
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

function stateLabel(state: TrafficExchangeSummary["state"]): string {
  if (state === "completed") return "完成"
  if (state === "failed") return "失败"
  if (state === "incomplete") return "不完整"
  return "进行中"
}

function requestLabel(exchange: TrafficExchangeSummary): string {
  if (exchange.transport === "websocket") {
    return exchange.url === undefined ? "WebSocket" : `WS ${exchange.url}`
  }
  if (exchange.method === undefined && exchange.path === undefined) return "—"
  return `${exchange.method ?? ""} ${exchange.path ?? ""}`
}
