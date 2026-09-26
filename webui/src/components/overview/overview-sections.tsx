import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
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
import {
  InputTokenTooltip,
  OutputTokenTooltip,
} from "@/components/metrics/token-tooltip"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { StatCard } from "@/components/metrics/stat-card"
import { AccountFreshnessBadge, AccountRefreshButton, AccountRefreshFeedback, AccountSnapshotEmpty } from "./account-refresh-feedback"
import { AccountSubscriptionNotice } from "./account-subscription-notice"
import type { AccountRefreshControl } from "@/lib/account-refresh-state"
import { useLanguage } from "@/hooks/language-context"
import {
  formatCount,
  formatErrorType,
  formatFailureRate,
  formatCacheUsage,
  formatPlanType,
  formatSuccessRate,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type {
  Aggregate,
  CcgCreditAccountUsage,
  DeepseekAccountBalance,
  ErrorsReport,
  OpencodeGoQuotaWindow,
  QuotaAccountUsage,
  ProviderGroup,
} from "@/lib/types"

export function GlobalCards({ global, threadCount, turnCount }: { global: Aggregate | null; threadCount: number; turnCount: number }) {
  if (global === null) {
    return (
      <Alert>
        <AlertTitle>暂无数据</AlertTitle>
        <AlertDescription>当前时间范围没有模型请求记录</AlertDescription>
      </Alert>
    )
  }
  const cache = formatCacheUsage(global.cacheUsage)
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        value={formatTokens(global.inputTokens + global.outputTokens)}
        description={`总计 Token · 请求 ${formatCount(global.requestCount)} 次 · 成功率 ${formatSuccessRate(global.requestCount, global.unsuccessfulRequestCount)}`}
      />
      <StatCard
        value={formatTokens(global.inputTokens)}
        description={`输入 Token · 其中缓存 ${cache.cached} · 命中率 ${cache.rate}`}
      />
      <StatCard
        value={formatTokens(global.outputTokens)}
        description="输出 Token"
      />
      <StatCard
        value={formatCount(threadCount)}
        description={`会话 · 轮次 ${formatCount(turnCount)} 轮`}
      />
    </div>
  )
}

export function ProviderTable({ providers }: { providers: ProviderGroup[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>按 Provider</CardTitle>
        <CardDescription>每组包含会话、轮次、请求、Token 与压缩统计</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>会话</TableHead>
              <TableHead>轮次</TableHead>
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
                <TableCell className="tabular-nums">{group.threadCount.toLocaleString("zh-CN")}</TableCell>
                <TableCell className="tabular-nums">{group.turnCount.toLocaleString("zh-CN")}</TableCell>
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
                <TableCell colSpan={7} className="h-16 text-center text-muted-foreground">
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

export function DeepseekBalanceCards({
  accounts,
  refreshControls,
}: {
  accounts: DeepseekAccountBalance[]
  refreshControls: Record<string, AccountRefreshControl>
}) {
  if (accounts.length === 0) {
    return <AccountProviderEmpty title="DS 账户余额" description="尚未配置 DeepSeek 账户" />
  }
  return <div className="flex flex-col gap-4">{accounts.map((account) => (
    <DeepseekBalanceCard
      key={account.provider}
      {...account}
      refreshControl={refreshControls[account.provider]}
    />
  ))}</div>
}

function DeepseekBalanceCard({
  displayName, default: isDefault, available, observedAtMs, balances, refreshControl,
}: DeepseekAccountBalance & { refreshControl: AccountRefreshControl | undefined }) {
  const primary = balances[0]
  return (
    <Card aria-busy={refreshControl?.refreshing}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-all">{displayName}</span><AccountFreshnessBadge observedAtMs={observedAtMs} /></CardTitle>
        <CardDescription>
          {isDefault ? "默认账户 · " : ""}{observedAtMs <= 0
            ? "DeepSeek 账户余额暂不可用"
            : `更新于 ${formatTime(observedAtMs)}`}
        </CardDescription>
        {refreshControl && !refreshControl.error && available && primary !== undefined
          ? <CardAction><AccountRefreshButton control={refreshControl} /></CardAction> : null}
      </CardHeader>
      {refreshControl?.error ? <CardContent><AccountRefreshFeedback control={refreshControl} hasSnapshot={available && primary !== undefined} /></CardContent> : null}
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
      ) : !refreshControl?.error ? <CardContent><AccountSnapshotEmpty control={refreshControl} /></CardContent> : null}
    </Card>
  )
}

export function CcgCreditUsageCards({
  accounts,
  refreshControls,
}: {
  accounts: CcgCreditAccountUsage[]
  refreshControls: Record<string, AccountRefreshControl>
}) {
  if (accounts.length === 0) {
    return <AccountProviderEmpty title="CommandCode Go 账户额度" description="尚未配置 CommandCode Go 账户" />
  }
  return <div className="flex flex-col gap-4">{accounts.map((account) => (
    <CcgCreditAccountCard
      key={account.provider}
      {...account}
      refreshControl={refreshControls[account.provider]}
    />
  ))}</div>
}

function CcgCreditAccountCard({
  displayName,
  default: isDefault,
  available,
  observedAtMs,
  planId,
  monthlyRemaining,
  purchasedRemaining,
  freeRemaining,
  totalRemaining,
  windows,
  refreshControl,
}: CcgCreditAccountUsage & { refreshControl: AccountRefreshControl | undefined }) {
  return (
    <Card aria-busy={refreshControl?.refreshing}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 break-all">{displayName}</span>
          {planId === null ? null : <Badge variant="outline">{planId}</Badge>}
          <AccountFreshnessBadge observedAtMs={observedAtMs} />
        </CardTitle>
        <CardDescription>
          {isDefault ? "默认账户 · " : ""}{observedAtMs <= 0
            ? "CommandCode Go 账户额度暂不可用"
            : `更新于 ${formatTime(observedAtMs)}`}
        </CardDescription>
        {refreshControl && !refreshControl.error && available
          ? <CardAction><AccountRefreshButton control={refreshControl} /></CardAction> : null}
      </CardHeader>
      {refreshControl?.error ? <CardContent><AccountRefreshFeedback control={refreshControl} hasSnapshot={available} /></CardContent> : null}
      {available ? <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums">${totalRemaining}</span>
          <span className="text-xs text-muted-foreground">
            月度 ${monthlyRemaining} · 充值 ${purchasedRemaining} · 赠送 ${freeRemaining}
          </span>
        </div>
        <QuotaWindows windows={windows} />
      </CardContent> : !refreshControl?.error ? <CardContent><AccountSnapshotEmpty control={refreshControl} /></CardContent> : null}
    </Card>
  )
}

function AccountProviderEmpty({ title, description }: { title: string; description: string }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader></Card>
}

export function OpencodeGoUsageCard({
  accounts,
  refreshControls,
  onAccountsChanged,
}: {
  accounts: Array<{
    subscriptionRequired: boolean
    account: string | null
    displayName: string
    default: boolean
    available: boolean
    windows: OpencodeGoQuotaWindow[]
    provider: string
    observedAtMs: number
  }>
  refreshControls: Record<string, AccountRefreshControl>
  onAccountsChanged: (accountId: string, activation?: string) => void
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
        <QuotaAccountCard
          key={account.provider}
          {...account}
          refreshControl={refreshControls[account.provider]}
          onRemoved={onAccountsChanged}
        />
      ))}
    </div>
  )
}

export function ClinePassUsageCard({ account, refreshControl }: {
  account: QuotaAccountUsage | null
  refreshControl: AccountRefreshControl | undefined
}) {
  if (!account) return null
  return <QuotaAccountCard {...account} refreshControl={refreshControl} />
}

function QuotaAccountCard({
  account,
  displayName,
  default: isDefault,
  available,
  windows,
  observedAtMs,
  refreshControl,
  onRemoved,
  subscriptionRequired,
}: {
  account: string | null
  provider: string
  displayName: string
  default: boolean
  available: boolean
  windows: OpencodeGoQuotaWindow[]
  observedAtMs: number
  refreshControl: AccountRefreshControl | undefined
  onRemoved?: (accountId: string, activation?: string) => void
  subscriptionRequired: boolean
}) {
  return (
    <Card aria-busy={refreshControl?.refreshing}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2"><span className="min-w-0 break-all">{displayName}</span>{subscriptionRequired ? <Badge variant="secondary">无有效订阅</Badge> : <AccountFreshnessBadge observedAtMs={observedAtMs} />}</CardTitle>
        <CardDescription>
          {isDefault ? "默认账户 · " : ""}
          {observedAtMs <= 0
            ? "账户用量暂不可用"
            : `${subscriptionRequired ? "订阅状态 · 确认于" : "账户配额 · 更新于"} ${formatTime(observedAtMs)}`}
        </CardDescription>
        {refreshControl && !refreshControl.error && available && windows.length > 0
          ? <CardAction><AccountRefreshButton control={refreshControl} /></CardAction> : null}
      </CardHeader>
      {subscriptionRequired && onRemoved
        ? <CardContent className="flex flex-col gap-3"><AccountSubscriptionNotice accountId={account} control={refreshControl} onRemoved={onRemoved} /></CardContent>
        : refreshControl?.error ? <CardContent><AccountRefreshFeedback control={refreshControl} hasSnapshot={available && windows.length > 0} /></CardContent> : null}
      {!subscriptionRequired && available && windows.length > 0 ? <CardContent><QuotaWindows windows={windows} /></CardContent> : !subscriptionRequired && !refreshControl?.error ? <CardContent><AccountSnapshotEmpty control={refreshControl} /></CardContent> : null}
    </Card>
  )
}

function QuotaWindows({ windows }: { windows: OpencodeGoQuotaWindow[] }) {
  if (windows.length === 0) return null
  return <div className="flex flex-col gap-3">{windows.map((window) => (
    <div key={window.windowId} className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-sm">
        <span>{window.label}</span>
        <span className="tabular-nums text-muted-foreground">已用 {window.usedPercent.toFixed(1)}%</span>
      </div>
      <Progress value={Math.min(100, window.usedPercent)} />
      <p className="text-xs text-muted-foreground">
        {window.resetsAt === null ? "重置时间未知" : `下次重置 ${formatTime(window.resetsAt)}`}
      </p>
      {window.localTokens !== null && window.localTokens !== undefined ? (
        <p className="text-xs text-muted-foreground">本地 Token 约 {formatTokens(window.localTokens)}</p>
      ) : null}
      {window.tokenEstimate?.status === "ready" ? <>
        <p className="text-xs text-muted-foreground">每 1% 约 {formatTokens(window.tokenEstimate.tokensPerPercent)} Token · 满额约 {formatTokens(window.tokenEstimate.tokensPerPercent * 100)} Token</p>
        <p className="text-xs text-muted-foreground">观测 {window.tokenEstimate.observedDeltaPercent.toFixed(2)} 个百分点 · {window.tokenEstimate.intervalCount} 个区间 · {window.tokenEstimate.requestCount} 次请求</p>
      </> : window.tokenEstimate ? <p className="text-xs text-muted-foreground">{window.tokenEstimate.status === "sampling" ? "Token 换算正在采样；使用后刷新额度以形成有效区间。" : "Token 换算暂不可用；官方额度不受影响。"}</p> : null}
    </div>
  ))}{windows.some(window => window.tokenEstimate) ? <p className="text-xs text-muted-foreground">按本机输入与输出 Token 观测估算，非官方固定兑换率；其他设备用量及模型、缓存差异会影响结果。</p> : null}</div>
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
          失败率 {formatFailureRate(errors.requestCount, errors.unsuccessfulRequestCount)}
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
