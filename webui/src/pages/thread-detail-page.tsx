import { Link, useParams } from "react-router"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { StatCard } from "@/components/metrics/stat-card"
import { useThreadRun, useThreadTurns } from "@/hooks/use-thread-detail"
import {
  formatAvgPer100M,
  formatCost,
  formatSpeed,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { Aggregate, TurnSummary } from "@/lib/types"

export function ThreadDetailPage() {
  const { id = "" } = useParams<{ id: string }>()
  const run = useThreadRun(id)
  const turns = useThreadTurns(id)

  const error = run.error ?? turns.error

  return (
    <div className="flex flex-col gap-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/threads">Threads</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="max-w-56 truncate">{id}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      {error === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {run.loading || run.data === null || turns.loading || turns.data === null
        ? <DetailSkeleton />
        : (
          <>
            <RunSummary
              latestTurn={run.data.latestTurn}
              threadAggregate={run.data.threadAggregate}
            />
            <TurnsTable turns={turns.data.turns} />
          </>
        )}
    </div>
  )
}

function RunSummary({
  latestTurn,
  threadAggregate,
}: {
  latestTurn: TurnSummary | null
  threadAggregate: (Aggregate & { turnCount: number }) | null
}) {
  if (threadAggregate === null) {
    return <Alert><AlertTitle>暂无数据</AlertTitle><AlertDescription>该 Thread 没有指标记录</AlertDescription></Alert>
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="Turn"
        value={threadAggregate.turnCount}
        description={latestTurn === null ? "无最近 Turn" : `最近 Turn ${latestTurn.requestCount} 次请求`}
      />
      <StatCard
        title="请求数"
        value={threadAggregate.requestCount.toLocaleString("zh-CN")}
        description={`失败 ${threadAggregate.unsuccessfulRequestCount}`}
      />
      <StatCard
        title="Token"
        value={formatTokens(threadAggregate.inputTokens + threadAggregate.outputTokens)}
        description={`输入 ${formatTokens(threadAggregate.inputTokens)} · 输出 ${formatTokens(threadAggregate.outputTokens)}`}
      />
      <StatCard
        title="费用"
        value={formatCost(threadAggregate)}
        description={`均价 ${formatAvgPer100M(threadAggregate)}`}
      />
    </div>
  )
}

function TurnsTable({ turns }: { turns: Array<{
  turnId: string
  model: string | null
  provider: string | null
  requestCount: number
  unsuccessfulRequestCount: number
  inputTokens: number
  outputTokens: number
  outputTokensPerSecond: number | null
  totalCostNanos: number | null
  totalCostCnyNanos?: number | null
  pricingCurrency: string | null
  compact: { requestCount: number } | null
  recordedAtMs?: number
}> }) {
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

function DetailSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index}>
          <CardHeader><Skeleton className="h-4 w-20" /></CardHeader>
          <CardContent><Skeleton className="h-8 w-28" /></CardContent>
        </Card>
      ))}
    </div>
  )
}
