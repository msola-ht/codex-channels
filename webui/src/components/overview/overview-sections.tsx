import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { CostTooltip } from "@/components/metrics/cost-tooltip"
import {
  InputTokenTooltip,
  OutputTokenTooltip,
} from "@/components/metrics/token-tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { StatCard } from "@/components/metrics/stat-card"
import { useCurrency } from "@/hooks/currency-context"
import { useLanguage } from "@/hooks/language-context"
import {
  formatAvgPer100M,
  formatCost,
  formatDuration,
  formatErrorType,
  formatPlanType,
  formatSpeed,
  formatSuccessRate,
  formatTime,
  formatTokens,
  type DisplayCurrency,
} from "@/lib/format"
import type {
  Aggregate,
  DeepseekBalance,
  ErrorsReport,
  OpencodeGoModelUsageEstimate,
  OpencodeGoQuotaWindow,
  ProviderGroup,
} from "@/lib/types"

export function GlobalCards({
  global,
  currency,
}: {
  global: Aggregate | null
  currency: DisplayCurrency | null
}) {
  if (global === null) {
    return (
      <Alert>
        <AlertTitle>暂无数据</AlertTitle>
        <AlertDescription>当前时间范围没有模型请求记录</AlertDescription>
      </Alert>
    )
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

export function ProviderTable({ providers }: { providers: ProviderGroup[] }) {
  const { currency } = useCurrency()
  return (
    <Card>
      <CardHeader>
        <CardTitle>按 Provider</CardTitle>
        <CardDescription>每组包含请求、Token、费用与均价（按当前币种 /100M）</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>请求</TableHead>
              <TableHead>输入 Token</TableHead>
              <TableHead>输出 Token</TableHead>
              <TableHead>费用</TableHead>
              <TableHead>均价</TableHead>
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
                <TableCell className="tabular-nums">
                  <InputTokenTooltip
                    inputTokens={group.aggregate.inputTokens}
                    cachedInputTokens={group.aggregate.cachedInputTokens}
                  />
                </TableCell>
                <TableCell className="tabular-nums">
                  <OutputTokenTooltip
                    outputTokens={group.aggregate.outputTokens}
                    reasoningOutputTokens={group.aggregate.reasoningOutputTokens}
                  />
                </TableCell>
                <TableCell>
                  <CostTooltip value={group.aggregate} currency={currency} />
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatAvgPer100M(group.aggregate, currency)}
                </TableCell>
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
                <TableCell colSpan={9} className="h-16 text-center text-muted-foreground">
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

export function WeeklyQuotaCard({
  usedPercent,
  resetsAt,
  planType,
}: {
  usedPercent: number | null
  resetsAt: number | null
  planType: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          OpenAI 周额度
          {planType === null ? null : (
            <Badge variant="outline">{formatPlanType(planType)}</Badge>
          )}
        </CardTitle>
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

export function DeepseekBalanceCard({
  available,
  balances,
}: {
  available: boolean
  balances: DeepseekBalance[]
}) {
  if (!available || balances.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>DS 剩余费用</CardTitle>
          <CardDescription>DeepSeek 账户余额暂不可用</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  const primary = balances[0]!
  return (
    <Card>
      <CardHeader>
        <CardTitle>DS 剩余费用</CardTitle>
        <CardDescription>DeepSeek 账户余额</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">
            {formatDeepseekAmount(primary.totalBalance, primary.currency)}
          </span>
          <span className="text-xs text-muted-foreground">
            赠金 {formatDeepseekAmount(primary.grantedBalance, primary.currency)}
            {" · "}
            充值 {formatDeepseekAmount(primary.toppedUpBalance, primary.currency)}
          </span>
        </div>
        {balances.length > 1 ? (
          <p className="text-xs text-muted-foreground">
            {balances.slice(1)
              .map((balance) =>
                formatDeepseekAmount(balance.totalBalance, balance.currency))
              .join(" · ")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function OpencodeGoUsageCard({
  available,
  windows,
  modelUsage = [],
}: {
  available: boolean
  windows: OpencodeGoQuotaWindow[]
  modelUsage?: OpencodeGoModelUsageEstimate[]
}) {
  if (!available || windows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>OpenCode Go 用量</CardTitle>
          <CardDescription>OpenCode Go 账户用量暂不可用</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>OpenCode Go 用量</CardTitle>
        <CardDescription>OpenCode Go 账户配额</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {windows.map((window) => (
          <div key={window.windowId} className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-sm">
              <span>{window.label}</span>
              <span className="tabular-nums text-muted-foreground">
                已用 {window.usedPercent.toFixed(1)}%
              </span>
            </div>
            <Progress value={Math.min(100, window.usedPercent)} />
            <p className="text-xs text-muted-foreground">
              {window.resetsAt === null
                ? "重置时间未知"
                : `下次重置 ${formatTime(window.resetsAt)}`}
            </p>
          </div>
        ))}
        {modelUsage.length === 0 ? null : (
          <div className="flex flex-col gap-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">
              模型本地用量
              {modelUsage[0]?.windowStartAtMs !== null &&
              modelUsage[0]?.windowStartAtMs !== undefined &&
              modelUsage[0]?.windowEndAtMs !== null
                ? `（月度窗口 ${formatTime(Math.floor(modelUsage[0].windowStartAtMs / 1_000))} – ${formatTime(Math.floor(modelUsage[0].windowEndAtMs / 1_000))}）`
                : ""}
              （按当前价格基线重算）
            </p>
            {modelUsage.map((estimate) => (
              <div key={estimate.model} className="flex flex-col gap-1">
                <div className="flex items-center justify-between text-sm">
                  <span>{estimate.model}</span>
                  <span className="tabular-nums text-muted-foreground">
                    {estimate.usedPercent === null
                      ? "未知"
                      : `${estimate.usedPercent.toFixed(1)}%`}
                  </span>
                </div>
                <Progress value={Math.min(100, estimate.usedPercent ?? 0)} />
                <p className="text-xs text-muted-foreground">
                  已用 {formatUsd(estimate.usedUsdNanos)} / 包含{" "}
                  {formatUsd(Math.round(estimate.includedUsageUsd * 1_000_000_000))}{" "}
                  · 剩余 {formatUsd(estimate.remainingUsdNanos)}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function formatUsd(nanos: number | null): string {
  return nanos === null ? "未知" : `$${(nanos / 1_000_000_000).toFixed(2)}`
}

function formatDeepseekAmount(value: string, currency: string): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return value
  const symbol = currency === "CNY"
    ? "¥"
    : currency === "USD"
      ? "$"
      : `${currency} `
  return `${symbol}${amount.toFixed(2)}`
}

export function ErrorsSummary({ errors }: { errors: ErrorsReport }) {
  const { language } = useLanguage()
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
                    {group.provider ?? "未知"} ·{" "}
                    {group.errorType === null
                      ? group.status
                      : formatErrorType(group.errorType, language)}
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
