import { useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { CostDisplay } from "@/components/metrics/cost-display"
import { CurrencyToggle } from "@/components/metrics/currency-toggle"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { RangeSelector } from "@/components/metrics/range-selector"
import { StatCard } from "@/components/metrics/stat-card"
import { useOverview } from "@/hooks/use-overview"
import { usePersistentState } from "@/hooks/use-persistent-state"
import {
  formatAvgPer100M,
  formatCost,
  formatDuration,
  formatSpeed,
  formatSuccessRate,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type { DisplayCurrency } from "@/lib/format"
import type { RangeName } from "@/lib/types"

export function OverviewPage() {
  const [range, setRange] = useState<RangeName>("24h")
  const [currency, setCurrency] = usePersistentState<DisplayCurrency>(
    "codex-webui:currency",
    "usd",
  )
  const { data, loading, error } = useOverview(range)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">概览</h1>
          <p className="text-sm text-muted-foreground">全局模型请求指标与参考费用</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <CurrencyToggle value={currency} onChange={setCurrency} />
          <RangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      {error === null ? null : (
        <Alert variant="destructive">
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading || data === null
        ? <OverviewSkeleton />
        : (
          <>
            <GlobalCards global={data.global} currency={currency} />
            <ProviderTable providers={data.providers} />
            <div className="grid gap-6 lg:grid-cols-2">
              <WeeklyQuotaCard
                usedPercent={data.weeklyQuota?.usedPercent ?? null}
                resetsAt={data.weeklyQuota?.resetsAt ?? null}
              />
              <ErrorsSummary errors={data.errors} />
            </div>
          </>
        )}
    </div>
  )
}

function GlobalCards({
  global,
  currency,
}: {
  global: OverviewData["global"]
  currency: DisplayCurrency
}) {
  if (global === null) {
    return <Alert><AlertTitle>暂无数据</AlertTitle><AlertDescription>当前时间范围没有模型请求记录</AlertDescription></Alert>
  }
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title="请求数"
        value={global.requestCount.toLocaleString("zh-CN")}
        description={`成功率 ${formatSuccessRate(global.requestCount, global.unsuccessfulRequestCount)}`}
      />
      <StatCard
        title="Token"
        value={formatTokens(global.inputTokens + global.outputTokens)}
        description={`输入 ${formatTokens(global.inputTokens)} · 输出 ${formatTokens(global.outputTokens)}`}
      />
      <StatCard
        title="费用"
        value={formatCost(global, currency)}
        description={`均价 ${formatAvgPer100M(global, currency)}`}
      />
      <StatCard
        title="响应"
        value={global.ttftAverageMs === null ? "—" : formatDuration(global.ttftAverageMs)}
        description={`P50 ${formatDuration(global.ttftP50Ms)} · P95 ${formatDuration(global.ttftP95Ms)}`}
      />
    </div>
  )
}

function ProviderTable({ providers }: { providers: OverviewData["providers"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>按 Provider</CardTitle>
        <CardDescription>每组包含请求、Token、参考费用与实际均价（元/100M）</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>请求</TableHead>
              <TableHead>输入 Token</TableHead>
              <TableHead>输出 Token</TableHead>
              <TableHead>费用 / 均价</TableHead>
              <TableHead>TTFT</TableHead>
              <TableHead>输出速度</TableHead>
              <TableHead>压缩</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {providers.map((group) => (
              <TableRow key={group.provider ?? "unknown"}>
                <TableCell><ProviderBadge provider={group.provider} /></TableCell>
                <TableCell className="tabular-nums">{group.aggregate.requestCount.toLocaleString("zh-CN")}</TableCell>
                <TableCell className="tabular-nums">{formatTokens(group.aggregate.inputTokens)}</TableCell>
                <TableCell className="tabular-nums">{formatTokens(group.aggregate.outputTokens)}</TableCell>
                <TableCell><CostDisplay value={group.aggregate} /></TableCell>
                <TableCell className="tabular-nums">{formatDuration(group.aggregate.ttftAverageMs)}</TableCell>
                <TableCell className="tabular-nums">{formatSpeed(group.aggregate.outputTokensPerSecond)}</TableCell>
                <TableCell className="tabular-nums">
                  {group.aggregate.compact === null
                    ? "无"
                    : `${group.aggregate.compact.requestCount} 次`}
                </TableCell>
              </TableRow>
            ))}
            {providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="h-16 text-center text-muted-foreground">
                  暂无数据
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

function WeeklyQuotaCard({
  usedPercent,
  resetsAt,
}: {
  usedPercent: number | null
  resetsAt: number | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>OpenAI 周额度</CardTitle>
        <CardDescription>
          {resetsAt === null ? "暂无限额快照" : `下次重置 ${formatTime(resetsAt)}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {usedPercent === null
          ? <p className="text-sm text-muted-foreground">当前时间范围没有 OpenAI 额度记录</p>
          : (
            <>
              <Progress value={Math.min(100, usedPercent)} />
              <p className="text-sm text-muted-foreground">
                已用 {usedPercent.toFixed(1)}% · 剩余 {(100 - usedPercent).toFixed(1)}%
              </p>
            </>
          )}
      </CardContent>
    </Card>
  )
}

function ErrorsSummary({ errors }: { errors: OverviewData["errors"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>错误摘要</CardTitle>
        <CardDescription>
          失败率 {formatSuccessRate(errors.requestCount, errors.unsuccessfulRequestCount)}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {errors.groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有异常请求</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {errors.groups.slice(0, 5).map((group) => (
              <li key={`${group.provider}-${group.model}-${group.status}-${group.errorType}`}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">
                    {group.provider ?? "未知"} · {group.errorType ?? group.status}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {group.requestCount} 次 · {formatTime(group.lastOccurredAtMs)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function OverviewSkeleton() {
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

type OverviewData = NonNullable<ReturnType<typeof useOverview>["data"]>
