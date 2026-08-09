import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { StatCard } from "@/components/metrics/stat-card"
import { useCurrency } from "@/hooks/currency-context"
import {
  formatAvgPer100M,
  formatCost,
  formatTokens,
} from "@/lib/format"
import type { Aggregate, TurnSummary } from "@/lib/types"

export function ThreadRunSummary({
  latestTurn,
  threadAggregate,
}: {
  latestTurn: TurnSummary | null
  threadAggregate: (Aggregate & { turnCount: number }) | null
}) {
  const { currency } = useCurrency()
  if (threadAggregate === null) {
    return (
      <Alert>
        <AlertTitle>暂无数据</AlertTitle>
        <AlertDescription>该 Thread 没有指标记录</AlertDescription>
      </Alert>
    )
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
        value={formatCost(threadAggregate, currency)}
        description={`均价 ${formatAvgPer100M(threadAggregate, currency)}`}
      />
    </div>
  )
}
