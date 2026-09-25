import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { StatCard } from "@/components/metrics/stat-card"
import {
  formatCount,
  formatTokens,
  formatTokensPerSecond,
} from "@/lib/format"
import type { Aggregate, TurnSummary } from "@/lib/types"

export function ThreadRunSummary({
  latestTurn,
  threadAggregate,
}: {
  latestTurn: TurnSummary | null
  threadAggregate: (Omit<Aggregate, "cacheUsage"> & { turnCount: number }) | null
}) {
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
        title="平均 Token/s"
        value={formatTokensPerSecond(threadAggregate.tokensPerSecond)}
        description="有效请求速率的算术平均，含已关联子代理"
      />
      <StatCard
        title="Turn"
        value={threadAggregate.turnCount}
        description={latestTurn === null ? "无最近 Turn" : `最近 Turn ${formatCount(latestTurn.requestCount)} 次请求`}
      />
      <StatCard
        title="请求数"
        value={formatCount(threadAggregate.requestCount)}
        description={`失败 ${formatCount(threadAggregate.unsuccessfulRequestCount)}`}
      />
      <StatCard
        title="Token"
        value={formatTokens(threadAggregate.inputTokens + threadAggregate.outputTokens)}
        description={`输入 ${formatTokens(threadAggregate.inputTokens)} · 输出 ${formatTokens(threadAggregate.outputTokens)}`}
      />
    </div>
  )
}
