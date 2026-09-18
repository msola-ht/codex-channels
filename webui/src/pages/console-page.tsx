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
  DeepseekBalanceCard,
  ErrorsSummary,
  GlobalCards,
  OpencodeGoUsageCard,
  ProviderTable,
  WeeklyQuotaCard,
} from "@/components/overview/overview-sections"
import { UsageCharts } from "@/components/overview/usage-charts"
import { useOfficialAccountSources } from "@/hooks/use-official-account-sources"
import type { AccountSnapshotFreshness } from "@/hooks/use-official-account-sources"
import { useDashboard } from "@/hooks/use-dashboard"
import { cn } from "@/lib/utils"
import type {
  DeepseekBalanceResponse,
  OpencodeGoUsageResponse,
  OverviewResponse,
  RangeName,
  MetricsRangeQuery,
} from "@/lib/types"

export function ConsolePage({ range, onRangeChange }: {
  range: MetricsRangeQuery
  onRangeChange: (range: MetricsRangeQuery) => void
}) {
  const dashboard = useDashboard(range)
  const refetch = dashboard.refetch
  const officialAccounts = useOfficialAccountSources()
  const refreshAccounts = officialAccounts.refresh
  const refreshing = dashboard.loading || officialAccounts.refreshing

  const refreshDashboard = useCallback(() => {
    refetch()
    void refreshAccounts()
  }, [refetch, refreshAccounts])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="shrink-0">
          <h1 className="text-xl font-semibold">控制台</h1>
          <p className="text-sm text-muted-foreground">本机指标库与账户状态</p>
        </div>
        <div className="flex w-full flex-wrap items-end justify-end gap-3 sm:w-auto sm:flex-1">
          <DashboardRangeSelector key={JSON.stringify(range)} query={range} onChange={onRangeChange} />
          <Button variant="outline" size="sm" disabled={refreshing} onClick={refreshDashboard}>
            {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            {refreshing ? "刷新中" : "刷新"}
          </Button>
        </div>
      </div>
      <LocalDashboard
        data={dashboard.data}
        loading={dashboard.loading}
        error={dashboard.error}
      />
      <AccountStatusCards
        overview={dashboard.data}
        balance={officialAccounts.data?.deepseek ?? null}
        opencodeGoUsage={officialAccounts.data?.opencodeGo ?? null}
        freshness={officialAccounts.data?.freshness ?? { deepseek: "missing", opencodeGo: "missing" }}
        accountError={officialAccounts.refreshError ?? officialAccounts.error ?? officialAccounts.data?.warning ?? null}
      />
    </div>
  )
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
            <ProviderTable providers={data.providers} />
            <ErrorsSummary errors={data.errors} />
          </>}
    </div>
  )
}

function DashboardRangeSelector({ query, onChange }: { query: MetricsRangeQuery; onChange: (query: MetricsRangeQuery) => void }) {
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
          label="汇总范围"
        />
        {value === "custom" ? <Button type="submit">查询</Button> : null}
      </FieldGroup>
    </form>
  )
}

function AccountStatusCards({
  overview,
  balance,
  opencodeGoUsage,
  freshness,
  accountError,
}: {
  overview: OverviewResponse | null
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
