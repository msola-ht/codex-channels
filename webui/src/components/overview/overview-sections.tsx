import { ResetCreditAction } from "./reset-credit-action"
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
import { useTranslation } from "@/hooks/use-translation"
import type { MessageKey, Translate } from "@/lib/i18n/messages"
import {
  formatCount,
  formatErrorType,
  formatFailureRate,
  formatCacheUsage,
  formatSuccessRate,
  formatTime,
  formatTokens,
} from "@/lib/format"
import type {
  Aggregate,
  OpenAiAccountCredits,
  CcgCreditAccountUsage,
  DeepseekAccountBalance,
  ErrorsReport,
  OpencodeGoQuotaWindow,
  QuotaAccountUsage,
  ProviderGroup,
} from "@/lib/types"

/** 订阅类型是 WebUI 展示标签：映射到字典键，未知值保留上游原文。 */
const planTypeKeys: Readonly<Record<string, MessageKey>> = {
  free: "overview.planTypes.free",
  go: "overview.planTypes.go",
  plus: "overview.planTypes.plus",
  pro: "overview.planTypes.pro",
  prolite: "overview.planTypes.prolite",
  promax: "overview.planTypes.promax",
  team: "overview.planTypes.team",
  self_serve_business_usage_based: "overview.planTypes.businessUsageBased",
  business: "overview.planTypes.business",
  ent26: "overview.planTypes.enterprise",
  enterprise_cbp_usage_based: "overview.planTypes.enterpriseUsageBased",
  enterprise: "overview.planTypes.enterprise",
  edu: "overview.planTypes.edu",
  unknown: "overview.planTypes.unknown",
}

function planTypeLabel(t: Translate, value: string): string {
  const key = planTypeKeys[value]
  return key === undefined ? value : t(key)
}

/** 配额窗口按稳定 windowId 取展示标签；未知窗口保留快照提供的标签。 */
const quotaWindowLabelKeys: Readonly<Record<string, MessageKey>> = {
  rolling: "overview.windowFiveHour",
  "five-hour": "overview.windowFiveHour",
  weekly: "overview.windowSevenDay",
  monthly: "overview.windowMonthly",
}

function quotaWindowLabel(t: Translate, window: OpencodeGoQuotaWindow): string {
  const key = quotaWindowLabelKeys[window.windowId]
  return key === undefined ? window.label : t(key)
}

export function GlobalCards({ global, threadCount, turnCount }: { global: Aggregate | null; threadCount: number; turnCount: number }) {
  const { t } = useTranslation()
  if (global === null) {
    return (
      <Alert>
        <AlertTitle>{t("overview.noData")}</AlertTitle>
        <AlertDescription>{t("overview.noRequestsInRange")}</AlertDescription>
      </Alert>
    )
  }
  const cache = formatCacheUsage(global.cacheUsage)
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        title={t("overview.totalTokens")}
        value={formatTokens(global.inputTokens + global.outputTokens)}
        description={t("overview.requestsSummary", {
          count: formatCount(global.requestCount),
          rate: formatSuccessRate(global.requestCount, global.unsuccessfulRequestCount),
        })}
      />
      <StatCard
        title={t("metrics.input")}
        value={formatTokens(global.inputTokens)}
        description={t("overview.cacheSummary", { cached: cache.cached, rate: cache.rate })}
      />
      <StatCard
        title={t("metrics.output")}
        value={formatTokens(global.outputTokens)}
      />
      <StatCard
        title={t("overview.threads")}
        value={formatCount(threadCount)}
        description={t("overview.turnCount", { count: formatCount(turnCount) })}
      />
    </div>
  )
}

export function ProviderTable({ providers }: { providers: ProviderGroup[] }) {
  const { t } = useTranslation()
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t("overview.byProvider")}</CardTitle>
        <CardDescription>{t("overview.currentRange")}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("metrics.provider")}</TableHead>
              <TableHead>{t("overview.threads")}</TableHead>
              <TableHead>{t("overview.turnColumn")}</TableHead>
              <TableHead>{t("metrics.requests")}</TableHead>
              <TableHead>{t("metrics.input")}</TableHead>
              <TableHead>{t("metrics.output")}</TableHead>
              <TableHead>{t("metrics.compact")}</TableHead>
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
                    ? t("overview.none")
                    : t("metrics.times", { count: group.aggregate.compact.requestCount })}
                </TableCell>
              </TableRow>
            ))}
            {providers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-16 text-center text-muted-foreground">
                  {t("overview.noData")}
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
  refreshControl,
  credits = null,
  onCreditsChanged,
  usedPercent,
  resetsAt,
  planType,
}: {
  refreshControl?: AccountRefreshControl
  onCreditsChanged?: () => void
  credits?: OpenAiAccountCredits | null
  usedPercent: number | null
  resetsAt: number | null
  planType: string | null
}) {
  const { t } = useTranslation()
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <CardTitle>{t("overview.weeklyQuotaTitle")}</CardTitle>
          {planType === null ? null : <Badge variant="outline">{planTypeLabel(t, planType)}</Badge>}
          <Badge variant="secondary">
            {t("overview.resetCreditsAvailable")} {credits?.resetCreditsAvailable ?? t("overview.creditNotProvided")}
          </Badge>
          {credits || refreshControl ? <AccountUpdateDescription observedAtMs={credits?.observedAtMs ?? 0} isDefault={false} refreshFailed={Boolean(refreshControl?.error)} /> : null}
        </div>
        {usedPercent === null ? null : <CardDescription className="ml-auto whitespace-nowrap tabular-nums">
          {t("overview.weeklyQuotaUsed", { percent: usedPercent.toFixed(1) })}
        </CardDescription>}
        {refreshControl && !refreshControl.error ? <CardAction><AccountRefreshButton control={refreshControl} /></CardAction> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <AccountRefreshFeedback control={refreshControl} hasSnapshot={credits !== null} />
        <div className="text-xs text-muted-foreground space-y-1">
          <p>{t("overview.subscriptionUntil")}: {credits?.subscription?.activeUntil == null ? t("overview.creditNotProvided") : formatTime(credits.subscription.activeUntil * 1000)}</p>
          <p>{t("overview.subscriptionLastChecked")}: {credits?.subscription?.lastChecked == null ? t("overview.creditNotProvided") : formatTime(credits.subscription.lastChecked * 1000)}</p>
          <p>{t("overview.subscriptionCacheNote")}</p>
        </div>
        {usedPercent === null
          ? <Empty className="min-h-20 p-3"><EmptyHeader><EmptyTitle>{t("overview.weeklyQuotaEmpty")}</EmptyTitle></EmptyHeader></Empty>
          : (
            <>
              <Progress value={Math.min(100, usedPercent)} aria-label={t("overview.weeklyQuotaProgress")} />
              <p className="text-xs leading-relaxed text-muted-foreground">
                {resetsAt === null ? t("overview.resetUnknown") : t("overview.resetAt", { time: formatTime(resetsAt) })}
              </p>
            </>
          )}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t("overview.creditsRemaining")}</dt>
          <dd className="text-right break-all tabular-nums">{credits?.unlimited ? t("overview.creditsUnlimited") : credits?.remaining ?? t("overview.creditNotProvided")}</dd>
        </dl>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {credits?.resetCreditsAvailable === "0" ? null : (
            <div className="flex max-w-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{t("overview.resetCreditsExpiry")}</span>
              <ul aria-label={t("overview.resetCreditsExpiry")} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {credits?.expirations?.map(expiration => <li key={expiration.expiresAt ?? "unlimited"} className="whitespace-nowrap tabular-nums">
                  {expiration.expiresAt === null ? t("overview.creditNoExpiry") : formatTime(expiration.expiresAt * 1000)}
                  {" · "}{t("overview.creditCount", { count: expiration.count })}
                </li>)}
                {credits?.undisclosedCount ? <li>{t("overview.creditExpiryUndisclosed", { count: credits.undisclosedCount })}</li>
                  : !credits?.expirations?.length ? <li>{t("overview.creditNotProvided")}</li> : null}
              </ul>
            </div>
          )}
          {onCreditsChanged ? <div className="ml-auto shrink-0"><ResetCreditAction onChanged={onCreditsChanged} /></div> : null}
        </div>
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
  const { t } = useTranslation()
  if (accounts.length === 0) {
    return <AccountProviderEmpty title="DeepSeek" description={t("overview.deepseekEmpty")} />
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
  account, displayName, default: isDefault, observedAtMs, balances, refreshControl,
}: DeepseekAccountBalance & { refreshControl: AccountRefreshControl | undefined }) {
  const { t } = useTranslation()
  const primary = balances[0]
  return (
    <Card size="sm" aria-busy={refreshControl?.refreshing}>
      <CardHeader className="min-w-0">
        <CardTitle className="flex flex-wrap items-center gap-2"><AccountName providerName="DeepSeek" account={account} displayName={displayName} /></CardTitle>
        <AccountUpdateDescription observedAtMs={observedAtMs} isDefault={isDefault} refreshFailed={Boolean(refreshControl?.error)} />
        {refreshControl && !refreshControl.error && primary !== undefined
          ? <CardAction><AccountRefreshButton control={refreshControl} /></CardAction> : null}
      </CardHeader>
      {refreshControl?.error ? <CardContent><AccountRefreshFeedback control={refreshControl} hasSnapshot={primary !== undefined} /></CardContent> : null}
      {primary !== undefined ? (
        <CardContent className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-2xl font-semibold tabular-nums">
              {formatDeepseekAmount(primary.totalBalance, primary.currency)}
            </span>
            <span className="text-xs text-muted-foreground">{t("overview.availableBalance")}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("overview.grantedBalance", { amount: formatDeepseekAmount(primary.grantedBalance, primary.currency) })}
            {" · "}
            {t("overview.toppedUpBalance", { amount: formatDeepseekAmount(primary.toppedUpBalance, primary.currency) })}
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
  const { t } = useTranslation()
  if (accounts.length === 0) {
    return <AccountProviderEmpty title="CommandCode Go" description={t("overview.ccgEmpty")} />
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
  const { t } = useTranslation()
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
            <CardHeader><CardTitle>{t("overview.remainingCredit")}</CardTitle></CardHeader>
            <CardContent className="flex flex-col gap-2">
              <p className="break-all text-xl font-semibold tabular-nums">${totalRemaining}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t("overview.monthlyRemaining", { amount: `$${monthlyRemaining}` })}<br />
                {t("overview.purchasedRemaining", { amount: `$${purchasedRemaining}` })}<br />
                {t("overview.freeRemaining", { amount: `$${freeRemaining}` })}
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
  const { t } = useTranslation()
  if (accounts.length === 0) {
    return <AccountProviderEmpty title="OpenCode Go" description={t("overview.openCodeGoEmpty")} />
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
  const { t } = useTranslation()
  return (
    <Card size="sm" aria-busy={refreshControl?.refreshing}>
      <CardHeader className="min-w-0">
        <CardTitle className="flex flex-wrap items-center gap-2"><AccountName providerName={providerName} account={account} displayName={displayName} />{subscriptionRequired ? <Badge variant="secondary">{t("overview.noActiveSubscription")}</Badge> : null}</CardTitle>
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
  const { t } = useTranslation()
  const orderedWindows = [...windows].sort((left, right) =>
    (quotaWindowOrder[left.windowId] ?? 3) - (quotaWindowOrder[right.windowId] ?? 3))
  return orderedWindows.map((window) => {
    const label = quotaWindowLabel(t, window)
    return (
      <Card key={window.windowId} size="sm" className="min-w-0 gap-2 data-[size=sm]:[--card-spacing:--spacing(2)]">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <CardTitle className="shrink-0">{label}</CardTitle>
          <CardDescription className="ml-auto whitespace-nowrap tabular-nums">
            <span className="sr-only">{t("overview.usedLabel")} </span>{window.usedPercent.toFixed(1)}%
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <Progress value={Math.min(100, window.usedPercent)} aria-label={t("overview.windowProgress", { label })} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            {window.resetsAt === null ? t("overview.resetUnknown") : t("overview.resetAt", { time: formatTime(window.resetsAt) })}
          </p>
          {window.localTokens !== null && window.localTokens !== undefined ? (
            <p className="text-xs text-muted-foreground">{t("overview.localTokens", { count: formatTokens(window.localTokens) })}</p>
          ) : null}
        </CardContent>
      </Card>
    )
  })
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
  const { t, language } = useTranslation()
  return (
    <Card size="sm">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <CardTitle>{t("overview.errorsTitle")}</CardTitle>
        <CardDescription className="ml-auto">
          {t("overview.failureRate", { rate: formatFailureRate(errors.requestCount, errors.unsuccessfulRequestCount) })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {errors.groups.length === 0 ? (
          <Empty className="min-h-20 p-3"><EmptyHeader><EmptyTitle>{t("common.noFailedRequests")}</EmptyTitle></EmptyHeader></Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {errors.groups.slice(0, 5).map((group) => (
              <li key={`${group.provider}-${group.model}-${group.status}-${group.errorType}`}>
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">
                    {group.provider ?? t("common.unknown")} ·{" "}
                    {group.errorType === null
                      ? group.status
                      : formatErrorType(group.errorType, language)}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {t("overview.countAndTime", {
                      count: group.requestCount,
                      time: formatTime(group.lastOccurredAtMs),
                    })}
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
