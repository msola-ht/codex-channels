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
import { AccountUpdateDescription, AccountRefreshButton, AccountRefreshFeedback, AccountSnapshotEmpty } from "./account-refresh-feedback"
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
        title="总 Token"
        value={formatTokens(global.inputTokens + global.outputTokens)}
        description={`请求 ${formatCount(global.requestCount)} 次 · 成功率 ${formatSuccessRate(global.requestCount, global.unsuccessfulRequestCount)}`}
      />
      <StatCard
        title="输入 Token"
        value={formatTokens(global.inputTokens)}
        description={`缓存 ${cache.cached} · 命中率 ${cache.rate}`}
      />
      <StatCard
        title="输出 Token"
        value={formatTokens(global.outputTokens)}
      />
      <StatCard
        title="会话"
        value={formatCount(threadCount)}
        description={`轮次 ${formatCount(turnCount)} 轮`}
      />
    </div>
  )
}

export function ProviderTable({ providers }: { providers: ProviderGroup[] }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>按 Provider</CardTitle>
        <CardDescription>当前汇总范围</CardDescription>
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
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <CardTitle className="flex items-center gap-2">
          OpenAI 周额度
          {planType === null ? null : (
            <Badge variant="outline">{formatPlanType(planType)}</Badge>
          )}
        </CardTitle>
        {usedPercent === null ? null : <CardDescription className="ml-auto whitespace-nowrap tabular-nums">
          已用 {usedPercent.toFixed(1)}%
        </CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {usedPercent === null
          ? <Empty className="min-h-20 p-3"><EmptyHeader><EmptyTitle>尚未获取 OpenAI 额度快照</EmptyTitle></EmptyHeader></Empty>
          : (
            <>
              <Progress value={Math.min(100, usedPercent)} aria-label="OpenAI 周额度已用比例" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {resetsAt === null ? "重置时间未知" : `重置 ${formatTime(resetsAt)}`}
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
    return <AccountProviderEmpty title="DeepSeek" description="尚未配置 DeepSeek 账户" />
  }
  return <>{accounts.map((account) => (
    <DeepseekBalanceCard
      key={account.provider}
      {...account}
      refreshControl={refreshControls[account.provider]}
    />
  ))}</>
}

function AccountName({ providerName, account, displayName }: { providerName: string; account: string | null; displayName: string }) {
  const label = account ?? (displayName === providerName ? null : displayName)
  return <>
    <span className="min-w-0 break-all">{providerName}</span>
    {label === null ? null : <Badge variant="outline" className="max-w-full"><span className="truncate" title={label}>{label}</span></Badge>}
  </>
}

function DeepseekBalanceCard({
  account, displayName, default: isDefault, available, observedAtMs, balances, refreshControl,
}: DeepseekAccountBalance & { refreshControl: AccountRefreshControl | undefined }) {
  const primary = balances[0]
  return (
    <Card size="sm" aria-busy={refreshControl?.refreshing}>
      <CardHeader className="min-w-0">
        <CardTitle className="flex flex-wrap items-center gap-2"><AccountName providerName="DeepSeek" account={account} displayName={displayName} /></CardTitle>
        <AccountUpdateDescription observedAtMs={observedAtMs} isDefault={isDefault} refreshFailed={Boolean(refreshControl?.error)} />
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
            <span className="text-xs text-muted-foreground">可用余额</span>
          </div>
          <p className="text-xs text-muted-foreground">
            赠金 {formatDeepseekAmount(primary.grantedBalance, primary.currency)}
            {" · "}
            充值 {formatDeepseekAmount(primary.toppedUpBalance, primary.currency)}
          </p>
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
    return <AccountProviderEmpty title="CommandCode Go" description="尚未配置 CommandCode Go 账户" />
  }
  return <>{accounts.map((account) => (
    <CcgCreditAccountCard
      key={account.provider}
      {...account}
      refreshControl={refreshControls[account.provider]}
    />
  ))}</>
}

function CcgCreditAccountCard({
  account,
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
    <Card size="sm" aria-busy={refreshControl?.refreshing}>
      <CardHeader className="min-w-0">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <AccountName providerName="CommandCode Go" account={account} displayName={displayName} />
          {planId === null ? null : <Badge variant="outline">{planId}</Badge>}
        </CardTitle>
        <AccountUpdateDescription observedAtMs={observedAtMs} isDefault={isDefault} refreshFailed={Boolean(refreshControl?.error)} />
        {refreshControl && !refreshControl.error && available
          ? <CardAction><AccountRefreshButton control={refreshControl} /></CardAction> : null}
      </CardHeader>
      {refreshControl?.error ? <CardContent><AccountRefreshFeedback control={refreshControl} hasSnapshot={available} /></CardContent> : null}
      {available ? <CardContent>
        <div className="grid grid-cols-3 gap-2">
          <Card size="sm" className="min-w-0 gap-2 data-[size=sm]:[--card-spacing:--spacing(2)]">
            <CardHeader><CardTitle>剩余额度</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="break-all text-xl font-semibold tabular-nums">${totalRemaining}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                月度 ${monthlyRemaining}<br />充值 ${purchasedRemaining}<br />赠送 ${freeRemaining}
              </p>
            </CardContent>
          </Card>
          <QuotaWindowCards windows={windows} />
        </div>
      </CardContent> : !refreshControl?.error ? <CardContent><AccountSnapshotEmpty control={refreshControl} /></CardContent> : null}
    </Card>
  )
}

function AccountProviderEmpty({ title, description }: { title: string; description: string }) {
  return <Card size="sm">
    <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
    <CardContent><Empty className="p-3"><EmptyHeader><EmptyTitle>{description}</EmptyTitle></EmptyHeader></Empty></CardContent>
  </Card>
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
    return <AccountProviderEmpty title="OpenCode Go" description="尚未配置 OpenCode Go 账户" />
  }
  return (
    <>
      {accounts.map((account) => (
        <QuotaAccountCard
          key={account.provider}
          {...account}
          refreshControl={refreshControls[account.provider]}
          providerName="OpenCode Go"
          onRemoved={onAccountsChanged}
        />
      ))}
    </>
  )
}

export function ClinePassUsageCard({ account, refreshControl }: {
  account: QuotaAccountUsage | null
  refreshControl: AccountRefreshControl | undefined
}) {
  if (!account) return null
  return <QuotaAccountCard {...account} providerName="Cline Pass" refreshControl={refreshControl} />
}

function QuotaAccountCard({
  account,
  displayName,
  providerName,
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
  providerName: string
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
    <Card size="sm" aria-busy={refreshControl?.refreshing}>
      <CardHeader className="min-w-0">
        <CardTitle className="flex flex-wrap items-center gap-2"><AccountName providerName={providerName} account={account} displayName={displayName} />{subscriptionRequired ? <Badge variant="secondary">无有效订阅</Badge> : null}</CardTitle>
        <AccountUpdateDescription observedAtMs={observedAtMs} isDefault={isDefault} refreshFailed={Boolean(refreshControl?.error)} />
        {refreshControl && !refreshControl.error && available && windows.length > 0
          ? <CardAction><AccountRefreshButton control={refreshControl} /></CardAction> : null}
      </CardHeader>
      {subscriptionRequired && onRemoved
        ? <CardContent className="flex flex-col gap-3"><AccountSubscriptionNotice accountId={account} control={refreshControl} onRemoved={onRemoved} /></CardContent>
        : refreshControl?.error ? <CardContent><AccountRefreshFeedback control={refreshControl} hasSnapshot={available && windows.length > 0} /></CardContent> : null}
      {!subscriptionRequired && available && windows.length > 0 ? <CardContent>
        <div className="grid grid-cols-3 gap-2"><QuotaWindowCards windows={windows} /></div>
      </CardContent> : !subscriptionRequired && !refreshControl?.error ? <CardContent><AccountSnapshotEmpty control={refreshControl} /></CardContent> : null}
    </Card>
  )
}

const quotaWindowOrder: Readonly<Record<string, number>> = {
  rolling: 0,
  "five-hour": 0,
  weekly: 1,
  monthly: 2,
}

function QuotaWindowCards({ windows }: { windows: OpencodeGoQuotaWindow[] }) {
  const orderedWindows = [...windows].sort((left, right) =>
    (quotaWindowOrder[left.windowId] ?? 3) - (quotaWindowOrder[right.windowId] ?? 3))
  return orderedWindows.map((window) => (
    <Card key={window.windowId} size="sm" className="min-w-0 gap-2 data-[size=sm]:[--card-spacing:--spacing(2)]">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <CardTitle className="shrink-0">{window.label}</CardTitle>
        <CardDescription className="ml-auto whitespace-nowrap tabular-nums">
          <span className="sr-only">已用 </span>{window.usedPercent.toFixed(1)}%
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Progress value={Math.min(100, window.usedPercent)} aria-label={`${window.label}已用比例`} />
        <p className="text-xs leading-relaxed text-muted-foreground">
          {window.resetsAt === null ? "重置时间未知" : `重置 ${formatTime(window.resetsAt)}`}
        </p>
        {window.localTokens !== null && window.localTokens !== undefined ? (
          <p className="text-xs text-muted-foreground">本地 Token 约 {formatTokens(window.localTokens)}</p>
        ) : null}
      </CardContent>
    </Card>
  ))
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
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <CardTitle>错误摘要</CardTitle>
        <CardDescription className="ml-auto">
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
