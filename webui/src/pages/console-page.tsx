import { useCallback, useEffect, useState } from "react"
import { RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { RangeSelector } from "@/components/metrics/range-selector"
import {
  DeepseekBalanceCard,
  ErrorsSummary,
  GlobalCards,
  OpencodeGoUsageCard,
  ProviderTable,
  WeeklyQuotaCard,
} from "@/components/overview/overview-sections"
import { UsageCharts } from "@/components/overview/usage-charts"
import { useDailyUsage } from "@/hooks/use-daily-usage"
import { useOfficialAccountSources } from "@/hooks/use-official-account-sources"
import type { AccountSnapshotFreshness } from "@/hooks/use-official-account-sources"
import { useOverview } from "@/hooks/use-overview"
import type {
  DeepseekBalanceResponse,
  DailyUsageResponse,
  OpencodeGoUsageResponse,
  OverviewResponse,
  RangeName,
} from "@/lib/types"

export function ConsolePage() {
  const [range, setRange] = useState<RangeName>("30d")
  const account = useOverview(range)
  const trend = useDailyUsage(range)
  const heatmap = useDailyUsage("90d")
  const [dashboard, setDashboard] = useState<{
    overview: OverviewResponse
    trend: DailyUsageResponse
  } | null>(null)
  const officialAccounts = useOfficialAccountSources()
  const refetchOverview = account.refetch
  const refetchTrend = trend.refetch
  const refetchHeatmap = heatmap.refetch
  const refreshAccounts = officialAccounts.refresh

  const refreshDashboard = useCallback(() => {
    refetchOverview()
    refetchTrend()
    refetchHeatmap()
    void refreshAccounts()
  }, [refetchHeatmap, refetchOverview, refetchTrend, refreshAccounts])

  useEffect(() => {
    if (account.data?.range.name === range && trend.data?.range.name === range) {
      setDashboard({ overview: account.data, trend: trend.data })
    }
  }, [account.data, range, trend.data])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">控制台</h1>
        <p className="text-sm text-muted-foreground">本机指标库与账户状态</p>
      </div>
      <LocalDashboard
        range={dashboard?.overview.range.name ?? range}
        onRangeChange={setRange}
        onRefresh={refreshDashboard}
        data={dashboard?.overview ?? null}
        loading={account.loading || trend.loading}
        refreshing={account.loading || trend.loading || heatmap.loading || officialAccounts.refreshing}
        error={account.error}
        trend={dashboard?.trend ?? null}
        trendError={trend.error}
        heatmap={heatmap.data}
        heatmapLoading={heatmap.loading}
        heatmapError={heatmap.error}
      />
      <AccountStatusCards
        overview={account.data}
        balance={officialAccounts.data?.deepseek ?? null}
        opencodeGoUsage={officialAccounts.data?.opencodeGo ?? null}
        freshness={officialAccounts.data?.freshness ?? { deepseek: "missing", opencodeGo: "missing" }}
        accountError={officialAccounts.refreshError ?? officialAccounts.error ?? officialAccounts.data?.warning ?? null}
      />
    </div>
  )
}

function LocalDashboard({
  range,
  onRangeChange,
  onRefresh,
  data,
  loading,
  refreshing,
  error,
  trend,
  trendError,
  heatmap,
  heatmapLoading,
  heatmapError,
}: {
  range: RangeName
  onRangeChange: (range: RangeName) => void
  onRefresh: () => void
  data: OverviewResponse | null
  loading: boolean
  refreshing: boolean
  error: string | null
  trend: DailyUsageResponse | null
  trendError: string | null
  heatmap: DailyUsageResponse | null
  heatmapLoading: boolean
  heatmapError: string | null
}) {
  return (
    <div className="flex flex-col gap-6" aria-busy={loading || heatmapLoading}>
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-sm text-muted-foreground">汇总范围</span>
        <RangeSelector value={range} onChange={onRangeChange} ariaLabel="汇总时间范围" />
        <Button variant="outline" size="sm" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
          {refreshing ? "刷新中" : "刷新"}
        </Button>
      </div>
      <ErrorBanner error={error} />
      {data === null
        ? <PageSkeleton rows={4} />
        : <>
            <GlobalCards global={data.global} />
            <UsageCharts
              trendRows={trend?.daily ?? []}
              trendRange={trend?.range ?? data.range}
              heatmapRows={heatmap?.daily ?? []}
              heatmapEndAtMs={heatmap?.range.endAtMs ?? data.range.endAtMs}
              heatmapLoading={heatmapLoading}
              error={trendError ?? heatmapError}
            />
            <ProviderTable providers={data.providers} />
            <ErrorsSummary errors={data.errors} />
          </>}
    </div>
  )
}

function AccountStatusCards({
  overview,
  balance,
  opencodeGoUsage,
  freshness,
  accountError,
}: {
  overview: ReturnType<typeof useOverview>["data"]
  balance: DeepseekBalanceResponse | null
  opencodeGoUsage: OpencodeGoUsageResponse | null
  freshness: { deepseek: AccountSnapshotFreshness; opencodeGo: AccountSnapshotFreshness }
  accountError: string | null
}) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">本地账户与额度</h2>
        <p className="text-sm text-muted-foreground">数据来自本机 Gateway 的账户快照。</p>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <WeeklyQuotaCard
          usedPercent={overview?.weeklyQuota?.usedPercent ?? null}
          resetsAt={overview?.weeklyQuota?.resetsAt ?? null}
          planType={overview?.weeklyQuota?.planType ?? null}
        />
        <div className="flex flex-col gap-2">
          <FreshnessNotice provider="DS" status={freshness.deepseek} />
          <DeepseekBalanceCard
            available={balance?.available ?? false}
            observedAtMs={balance?.observedAtMs ?? 0}
            balances={balance?.balances ?? []}
          />
        </div>
        <div className="flex flex-col gap-2">
          {opencodeGoUsage !== null && opencodeGoUsage.accounts.length > 0
            ? <FreshnessNotice provider="OCG" status={freshness.opencodeGo} />
            : null}
          <OpencodeGoUsageCard
            accounts={opencodeGoUsage?.accounts ?? []}
          />
        </div>
      </div>
      <ErrorBanner error={accountError} />
    </div>
  )
}

function FreshnessNotice({
  provider,
  status,
}: {
  provider: "DS" | "OCG"
  status: AccountSnapshotFreshness
}) {
  if (status === "fresh") return null
  return (
    <Alert>
      <AlertTitle>{provider} 账户快照需要刷新</AlertTitle>
      <AlertDescription>
        {status === "missing" ? "尚未获取到账户快照。" : "本地快照已超过 15 分钟。"}
        可使用汇总范围旁的刷新按钮实时查询。
      </AlertDescription>
    </Alert>
  )
}
