import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import {
  formatCost,
  formatSpeed,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { TurnSummary } from "@/lib/types"

export function TurnTable({ turns }: { turns: TurnSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>每轮明细</CardTitle>
        <CardDescription>按记录时间倒序</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>时间</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>模型</TableHead>
              <TableHead>请求</TableHead>
              <TableHead>失败</TableHead>
              <TableHead>输入 Token</TableHead>
              <TableHead>输出 Token</TableHead>
              <TableHead>速度</TableHead>
              <TableHead>费用</TableHead>
              <TableHead>压缩</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...turns].reverse().map((turn) => (
              <TableRow key={turn.turnId}>
                <TableCell className="tabular-nums text-muted-foreground">
                  {formatTime(turn.recordedAtMs ?? null)}
                </TableCell>
                <TableCell><ProviderBadge provider={turn.provider} /></TableCell>
                <TableCell className="max-w-48 truncate">{turn.model ?? "—"}</TableCell>
                <TableCell className="tabular-nums">{turn.requestCount}</TableCell>
                <TableCell className="tabular-nums">{turn.unsuccessfulRequestCount}</TableCell>
                <TableCell className="tabular-nums">{formatTokens(turn.inputTokens)}</TableCell>
                <TableCell className="tabular-nums">{formatTokens(turn.outputTokens)}</TableCell>
                <TableCell className="tabular-nums">{formatSpeed(turn.outputTokensPerSecond)}</TableCell>
                <TableCell className="tabular-nums">{formatCost(turn)}</TableCell>
                <TableCell className="tabular-nums">
                  {turn.compact === null ? "—" : `${turn.compact.requestCount} 次`}
                </TableCell>
              </TableRow>
            ))}
            {turns.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="h-16 text-center text-muted-foreground">
                  暂无明细
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
