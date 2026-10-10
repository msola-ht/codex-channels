import { RefreshStatus } from "@/components/metrics/refresh-status"
import { useCallback, useState } from "react"
import { RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FieldGroup } from "@/components/ui/field"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { RangeSelector } from "@/components/metrics/range-selector"
import {
  CcgCreditUsageCards,
  ClinePassUsageCard,
  DeepseekBalanceCards,
  ErrorsSummary,
  GlobalCards,
  OpencodeGoUsageCard,
  ProviderTable,
  WeeklyQuotaCard,
} from "@/components/overview/overview-sections"
import { UsageCharts } from "@/components/overview/usage-charts"
import { ModelUsageSection } from "@/components/overview/model-usage"
import { useOfficialAccountSources } from "@/hooks/use-official-account-sources"
import { useTranslation } from "@/hooks/use-translation"
import type { AccountRefreshAttempts, AccountRefreshControl, AccountRefreshFailure, AccountRemovalNotice } from "@/lib/account-refresh-state"
import { useDashboard } from "@/hooks/use-dashboard"
import { translateApiError, translateApiErrorCode } from "@/lib/i18n/translate"
import type { Translate } from "@/lib/i18n/messages"
import { cn } from "cn"
import type {
  OpenAiAccountCredits,
  CcgCreditUsageResponse,
  QuotaAccountUsage,
  DeepseekBalanceResponse,
  OpencodeGoUsageResponse,
  OverviewResponse,
  OfficialAccountSnapshotsResponse,
  RangeName,
  MetricsRangeQuery,
} from "@/lib/types"

export function ConsolePage({ range, onRangeChange, refreshAttempts }: {
  refreshAttempts: AccountRefreshAttempts
  range: MetricsRangeQuery
  onRangeChange: (range: MetricsRangeQuery) => void
}) {
  const { t } = useTranslation()
  const dashboard = useDashboard(range)
  const refetch = dashboard.refetch
  const officialAccounts = useOfficialAccountSources(refreshAttempts)
  const refreshAccounts = officialAccounts.refresh
  const refreshing = dashboard.refreshing || officialAccounts.refreshing

  const refreshDashboard = useCallback(() => {
    refetch()
    void refreshAccounts(undefined, true)
  }, [refetch, refreshAccounts])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="shrink-0">
          <h1 className="text-xl font-semibold">{t("pages.console")}</h1>
          <p className="text-sm text-muted-foreground">{t("console.description")}</p>
        </div>
        <div className="flex w-full flex-wrap items-end justify-end gap-3 sm:w-auto sm:flex-1">
          <RefreshStatus status={dashboard.notificationStatus} updatedAt={dashboard.lastUpdatedAt} failed={dashboard.error !== null} />
          <DashboardRangeSelector key={JSON.stringify(range)} query={range} onChange={onRangeChange} />
          <Button variant="outline" size="sm" disabled={refreshing} onClick={refreshDashboard}>
            {refreshing ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : <RefreshCwIcon data-icon="inline-start" />}
            {refreshing ? t("common.refreshing") : t("common.refresh")}
          </Button>
        </div>
      </div>
      <LocalDashboard
        data={dashboard.data}
        loading={dashboard.loading}
        error={translateApiError(t, dashboard.error, dashboard.errorCode)}
      />
      <AccountStatusCards
        onAccountRemoved={officialAccounts.accountRemoved}
        removalNotice={officialAccounts.removalNotice}
        weeklyQuota={officialAccounts.data?.openaiWeeklyQuota ?? null}
        openai={officialAccounts.data?.openai ?? null}
        onCreditsChanged={officialAccounts.refetchSnapshots}
        accountDataLoaded={officialAccounts.data !== null}
        accountLoading={officialAccounts.loading}
        deepseek={officialAccounts.data?.deepseek ?? null}
        opencodeGoUsage={officialAccounts.data?.opencodeGo ?? null}
        ccgUsage={officialAccounts.data?.ccg ?? null}
        clinePass={officialAccounts.data?.clinePass ?? []}
        refreshControls={officialAccounts.refreshControls}
        accountError={accountRefreshFailureText(t, officialAccounts.refreshError)
          ?? translateApiError(t, officialAccounts.error, officialAccounts.errorCode)}
        accountWarnings={officialAccounts.data?.warnings ?? []}
        refreshing={officialAccounts.refreshing}
        onRefresh={() => void refreshAccounts(undefined, true)}
      />
      <p className="text-xs text-muted-foreground" role="status">{t("console.accountSnapshotUpdates", { status: t(`delivery.notifications.${officialAccounts.notificationStatus}`) })}</p>
    </div>
  )
}

function accountRefreshFailureText(t: Translate, failure: AccountRefreshFailure | null): string | null {
  if (failure === null) return null
  switch (failure.kind) {
    case "syncFailed":
      return t("console.accountSyncFailed", { message: translateApiErrorCode(t, failure.code) })
    case "listFailed":
      return translateApiErrorCode(t, failure.code)
  }
}

function LocalDashboard({
  data,
  loading,
  error,
}: {
  data: OverviewResponse | null
  loading: boolean
  error: string | null
}) {
  return (
    <div className="flex flex-col gap-6" aria-busy={loading}>
      <ErrorBanner error={error} />
      {data === null
        ? (error === null ? <PageSkeleton rows={4} /> : null)
        : <>
            <GlobalCards global={data.global} threadCount={data.threadCount} turnCount={data.turnCount} />
            <UsageCharts
              trend={data.trend}
              heatmapRows={data.heatmap.daily}
              heatmapEndAtMs={data.heatmap.range.endAtMs}
              heatmapLoading={loading}
              error={error}
            />
            <ModelUsageSection key={data.range.name} models={data.models} />
            <ProviderTable providers={data.providers} />
            <ErrorsSummary errors={data.errors} />
          </>}
    </div>
  )
}

function DashboardRangeSelector({ query, onChange }: { query: MetricsRangeQuery; onChange: (query: MetricsRangeQuery) => void }) {
  const { t } = useTranslation()
  const [value, setValue] = useState<RangeName | "custom">(query.range ?? "custom")
  const [dates, setDates] = useState({ from: query.from ?? "", to: query.to ?? "" })
  return (
    <form className={cn("w-full", value === "custom" ? "max-w-2xl" : "sm:w-48")} onSubmit={(event) => {
      event.preventDefault()
      onChange(value === "custom" ? dates : { range: value })
    }}>
      <FieldGroup className={cn("grid grid-cols-1 items-end gap-3", value === "custom" && "sm:grid-cols-[repeat(3,minmax(0,1fr))_auto]")}>
        <RangeSelector
          value={value}
          onChange={(next) => {
            setValue(next)
            if (next !== "custom") onChange({ range: next })
          }}
          from={dates.from}
          to={dates.to}
          onDateChange={(key, date) => setDates((previous) => ({ ...previous, [key]: date }))}
          label={t("console.summaryRange")}
        />
        {value === "custom" ? <Button type="submit">{t("filters.query")}</Button> : null}
      </FieldGroup>
    </form>
  )
}

function AccountStatusCards({
  onAccountRemoved,
  removalNotice,
  weeklyQuota,
  openai,
  onCreditsChanged,
  accountDataLoaded,
  accountLoading,
  deepseek,
  opencodeGoUsage,
  ccgUsage,
  clinePass,
  refreshControls,
  accountError,
  accountWarnings,
  refreshing,
  onRefresh,
}: {
  onAccountRemoved: (accountId: string, activation?: string) => void
  removalNotice: AccountRemovalNotice | null
  onCreditsChanged: () => void
  openai: OpenAiAccountCredits | null
  weeklyQuota: { usedPercent: number | null; resetsAt: number | null; planType: string | null } | null
  accountDataLoaded: boolean
  accountLoading: boolean
  deepseek: DeepseekBalanceResponse | null
  opencodeGoUsage: OpencodeGoUsageResponse | null
  ccgUsage: CcgCreditUsageResponse | null
  clinePass: QuotaAccountUsage[]
  refreshControls: Record<string, AccountRefreshControl>
  accountError: string | null
  accountWarnings: OfficialAccountSnapshotsResponse["warnings"]
  refreshing: boolean
  onRefresh: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">{t("console.accountTitle")}</h2>
        <p className="text-sm text-muted-foreground">{t("console.accountDescription")}</p>
      </div>
      {accountError ? <Alert variant="destructive">
        <AlertTitle>{t("console.accountErrorTitle")}</AlertTitle>
        <AlertDescription>
          <p>{accountError}</p>
          <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}>
            {refreshing ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : <RefreshCwIcon data-icon="inline-start" />}
            {refreshing ? t("common.refreshing") : t("common.retry")}
          </Button>
        </AlertDescription>
      </Alert> : null}
      {accountWarnings.map((warning) => <Alert key={warning.source}><AlertTitle>{t("console.accountWarningTitle")}</AlertTitle><AlertDescription>{warning.message}</AlertDescription></Alert>)}
      {removalNotice ? <Alert><AlertTitle>{t("console.accountRemovedTitle")}</AlertTitle><AlertDescription>
        {t("console.accountRemovedNotice", { account: removalNotice.accountId })}
        {removalNotice.restartRequired ? ` ${t("console.accountRemovedRestart")}` : ""}
      </AlertDescription></Alert> : null}
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <WeeklyQuotaCard
          refreshControl={refreshControls.openai}
          credits={openai}
          onCreditsChanged={onCreditsChanged}
          usedPercent={weeklyQuota?.usedPercent ?? null}
          resetsAt={weeklyQuota?.resetsAt ?? null}
          planType={weeklyQuota?.planType ?? null}
        />
        {accountDataLoaded ? <>
          {(deepseek?.accounts.length ?? 0) > 0 || !accountWarnings.some((warning) => warning.source === "deepseek") ? <DeepseekBalanceCards
            accounts={deepseek?.accounts ?? []}
            refreshControls={refreshControls}
          /> : null}
          {(opencodeGoUsage?.accounts.length ?? 0) > 0 || !accountWarnings.some((warning) => warning.source === "opencode-go") ? <OpencodeGoUsageCard
            accounts={opencodeGoUsage?.accounts ?? []}
            refreshControls={refreshControls}
            onAccountsChanged={onAccountRemoved}
          /> : null}
          {clinePass.map(account => <ClinePassUsageCard key={account.provider} account={account} refreshControl={refreshControls[account.provider]} />)}
          {(ccgUsage?.accounts.length ?? 0) > 0 || !accountWarnings.some((warning) => warning.source === "ccg") ? <CcgCreditUsageCards
            accounts={ccgUsage?.accounts ?? []}
            refreshControls={refreshControls}
          /> : null}
        </> : accountLoading ? <div aria-busy="true" aria-label={t("console.loadingAccounts")}><PageSkeleton rows={3} /></div> : null}
      </div>
    </div>
  )
}
