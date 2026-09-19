import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TableHint } from "@/components/metrics/data-table"
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
import { trafficCallKey } from "@/lib/traffic-state"

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
  return (
    <div className="min-w-0">
      <Table className="min-w-[960px]">
        <TableHeader>
          <TableRow>
            <TableHead>时间</TableHead>
            <TableHead>Provider</TableHead>
            <TableHead>模型</TableHead>
            <TableHead>状态</TableHead>
            <TableHead className="text-right">总耗时</TableHead>
            <TableHead className="text-right whitespace-nowrap">Turn State 字符数</TableHead>
            <TableHead>类型</TableHead>
            <TableHead>请求</TableHead>
            <TableHead>线程</TableHead>
            <TableHead>轮次</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? Array.from({ length: 5 }, (_, index) => (
            <TableRow key={index}>{Array.from({ length: 10 }, (_, column) => (
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
                  aria-label={`查看 ${exchange.label} ${formatTime(exchange.startedAtMs)} 的调用明细`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen(exchange)
                  }}
                >{formatTime(exchange.startedAtMs)}</Button>
              </TableCell>
              <TableCell><Badge variant="outline">{exchange.label}</Badge></TableCell>
              <TableCell>
                <TrafficModel request={exchange.requestModel} responses={exchange.responseModels} />
              </TableCell>
              <TableCell className="whitespace-nowrap text-xs">
                {exchange.status === undefined ? "" : `HTTP ${exchange.status} · `}
                {stateLabel(exchange.state)}
                {exchange.hasError ? <Badge className="ml-2" variant="destructive">异常</Badge> : null}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <TableHint hint="调用索引记录的总耗时；详细阶段及计时来源见调用明细。">{exchange.durationMs === undefined ? "—" : formatElapsedDuration(exchange.durationMs)}</TableHint>
              </TableCell>
              <TableCell className="text-right whitespace-nowrap tabular-nums">
                <TableHint hint={turnStatesError ?? (lengths === undefined ? "正在读取字符数，不影响查看调用" : lengths.length === 0 ? "未记录 X-Codex-Turn-State" : lengths.map((entry) => `${entry.characters.toLocaleString("zh-CN")} 字符 · ${entry.source}`).join("；"))}>
                  <span className="block max-w-40 truncate">{turnStatesError !== null ? "加载失败" : lengths === undefined ? "加载中…" : lengths.length === 0 ? "—" : [...new Set(lengths.map((entry) => entry.characters))].map((count) => count.toLocaleString("zh-CN")).join(" / ")}</span>
                </TableHint>
              </TableCell>
              <TableCell className="text-xs">{exchange.category === "models" ? "模型列表"
                : exchange.category === "prewarm" ? "连接预热" : exchange.requestKind ?? "模型请求"}</TableCell>
              <TableCell><TableHint hint={requestLabel(exchange)}><span className="block max-w-72 truncate font-mono text-xs">{requestLabel(exchange)}</span></TableHint></TableCell>
              <TableCell><TableHint hint={exchange.threadId ?? "未提供线程"}><span className="block max-w-40 truncate font-mono text-xs">{exchange.threadId ?? "—"}</span></TableHint></TableCell>
              <TableCell><TableHint hint={exchange.turnId ?? "未提供轮次"}><span className="block max-w-32 truncate font-mono text-xs">{exchange.turnId ?? "—"}</span></TableHint></TableCell>
            </TableRow>
          )})}
          {!loading && exchanges.length === 0 ? (
            <TableRow>
              <TableCell colSpan={10} className="h-16 text-center text-muted-foreground">
                没有调用记录
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
