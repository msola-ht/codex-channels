import { formatCount, formatTokens, formatSuccessRate, formatTime } from "@/lib/format"
import type { Aggregate, Range } from "@/lib/types"
import { cn } from "@/lib/utils"

export function QuerySummary({ aggregate, range, turns, loading = false }: { aggregate: Aggregate | null; range: Range<string>; turns?: number; loading?: boolean }) {
  return (
    <div className={cn("flex shrink-0 flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground", loading && "invisible")} aria-hidden={loading || undefined}>
      <span>期间统计 · {range.name === "all" ? "全部保留历史" : `${formatTime(range.startAtMs)} 至 ${formatTime(range.endAtMs)}（不含结束时刻）`}</span>
      {turns === undefined ? null : <span>{formatCount(turns)} 轮</span>}
      <span>请求 {formatCount(aggregate?.requestCount ?? 0)}</span>
      <span>成功率 {formatSuccessRate(aggregate?.requestCount ?? 0, aggregate?.unsuccessfulRequestCount ?? 0)}</span>
      <span>输入 {formatTokens(aggregate?.inputTokens ?? 0)} · 缓存 {formatTokens(aggregate?.cachedInputTokens ?? null)}</span>
      <span>输出 {formatTokens(aggregate?.outputTokens ?? 0)}</span>
    </div>
  )
}
