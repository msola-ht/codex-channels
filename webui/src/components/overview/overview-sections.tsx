import { RefreshCwIcon } from "lucide-react"

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
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
import {
  InputTokenTooltip,
  OutputTokenTooltip,
} from "@/components/metrics/token-tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { StatCard } from "@/components/metrics/stat-card"
import { useLanguage } from "@/hooks/language-context"
import {
  formatErrorType,
  formatPlanType,
  formatSuccessRate,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type {
  Aggregate,
  DeepseekBalance,
  ErrorsReport,
  OpencodeGoQuotaWindow,
  ProviderGroup,
} from "@/lib/types"

export function GlobalCards({ global }: { global: Aggregate | null }) {
  if (global === null) {
    return (
      <Alert>
        <AlertTitle>暂无数据</AlertTitle>
        <AlertDescription>当前时间范围没有模型请求记录</AlertDescription>
      </Alert>
    )
  }
  const cacheHitRate = global.inputTokens > 0 && global.cachedInputTokens !== null
    ? `${(global.cachedInputTokens / global.inputTokens * 100).toFixed(1)}%`
    : "—"
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        value={formatTokens(global.inputTokens + global.outputTokens)}
        description={`总计 Token · 请求 ${global.requestCount.toLocaleString("zh-CN")} 次 · 成功率 ${formatSuccessRate(global.requestCount, global.unsuccessfulRequestCount)}`}
      />
      <StatCard
        value={formatTokens(global.inputTokens)}
        description="输入 Token"
      />
      <StatCard
        value={formatTokens(global.cachedInputTokens)}
        description={`缓存 Token · 命中率 ${cacheHitRate}`}
      />
      <StatCard
        value={formatTokens(global.outputTokens)}
        description="输出 Token"
      />
    </div>
  )
}

export function ProviderTable({ providers }: { providers: ProviderGroup[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>按 Provider</CardTitle>
        <CardDescription>每组包含请求、Token 与压缩统计</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>请求</TableHead>
              <TableHead>输入 Token</TableHead>
              <TableHead>输出 Token</TableHead>
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
                <TableCell className="tabular-nums">
                  {group.aggregate.compact === null
                    ? "无"
                    : `${group.aggregate.compact.requestCount} 次`}
                </TableCell>
              </TableRow>
            ))}
            {providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
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
          ? <Empty className="min-h-20 p-3"><EmptyHeader><EmptyTitle>当前时间范围没有 OpenAI 额度记录</EmptyTitle></EmptyHeader></Empty>
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
  observedAtMs,
  balances,
  refreshing,
  refreshDisabled,
  onRefresh,
}: {
  available: boolean
  observedAtMs: number
  balances: DeepseekBalance[]
  refreshing: boolean
  refreshDisabled: boolean
  onRefresh: () => void
}) {
  const primary = balances[0]
  return (
    <Card>
      <CardHeader>
        <CardTitle>DS 账户余额</CardTitle>
        <CardDescription>
          {!available || primary === undefined
            ? "DeepSeek 账户余额暂不可用"
            : `更新于 ${formatTime(observedAtMs)}`}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={refreshDisabled} onClick={onRefresh}>
            {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {refreshing ? "刷新中" : "刷新余额"}
          </Button>
        </CardAction>
      </CardHeader>
      {available && primary !== undefined ? (
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
      ) : null}
    </Card>
  )
}

export function OpencodeGoUsageCard({
  accounts,
  refreshingProvider,
  refreshDisabled,
  onRefresh,
}: {
  accounts: Array<{
    account: string
    displayName: string
    default: boolean
    available: boolean
    windows: OpencodeGoQuotaWindow[]
    provider: string
    observedAtMs: number
  }>
  refreshingProvider: string | null
  refreshDisabled: boolean
  onRefresh: (provider: string) => void
}) {
  if (accounts.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>OpenCode Go 用量</CardTitle>
          <CardDescription>尚未配置 OpenCode Go 账户</CardDescription>
        </CardHeader>
      </Card>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {accounts.map((account) => (
        <OpencodeGoAccountCard
          key={account.account}
          {...account}
          refreshing={refreshingProvider === account.provider}
          refreshDisabled={refreshDisabled}
          onRefresh={() => onRefresh(account.provider)}
        />
      ))}
    </div>
  )
}

function OpencodeGoAccountCard({
  displayName,
  default: isDefault,
  available,
  windows,
  observedAtMs,
  refreshing,
  refreshDisabled,
  onRefresh,
}: {
  provider: string
  displayName: string
  default: boolean
  available: boolean
  windows: OpencodeGoQuotaWindow[]
  observedAtMs: number
  refreshing: boolean
  refreshDisabled: boolean
  onRefresh: () => void
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{displayName}</CardTitle>
        <CardDescription>
          {isDefault ? "默认账户 · " : ""}
          {!available || windows.length === 0
            ? "账户用量暂不可用"
            : `账户配额 · 更新于 ${formatTime(observedAtMs)}`}
        </CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" disabled={refreshDisabled} onClick={onRefresh}>
            {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {refreshing ? "刷新中" : "刷新额度"}
          </Button>
        </CardAction>
      </CardHeader>
      {available && windows.length > 0 ? <CardContent className="flex flex-col gap-3">
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
            {window.localTokens !== null && window.localTokens !== undefined ? (
              <p className="text-xs text-muted-foreground">
                本地 Token 约 {formatTokens(window.localTokens)}
              </p>
            ) : null}
            {window.totalUsd !== null && window.totalUsd !== undefined ? (
              <p className="text-xs text-muted-foreground">
                总额 ${window.totalUsd.toFixed(2)}
              </p>
            ) : null}
          </div>
        ))}
      </CardContent> : null}
    </Card>
  )
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
          <Empty className="min-h-20 p-3"><EmptyHeader><EmptyTitle>没有异常请求</EmptyTitle></EmptyHeader></Empty>
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
