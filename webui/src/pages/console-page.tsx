import { useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
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
import { useOfficialAccountSources } from "@/hooks/use-official-account-sources"
import type { AccountSnapshotFreshness } from "@/hooks/use-official-account-sources"
import { useOverview } from "@/hooks/use-overview"
import type {
  DeepseekBalanceResponse,
  OpencodeGoUsageResponse,
  OverviewResponse,
  RangeName,
} from "@/lib/types"

export function ConsolePage() {
  const [range, setRange] = useState<RangeName>("90d")
  const account = useOverview(range)
  const officialAccounts = useOfficialAccountSources()

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">控制台</h1>
        <p className="text-sm text-muted-foreground">本机指标库与账户状态</p>
      </div>
      <LocalDashboard range={range} onRangeChange={setRange} data={account.data} loading={account.loading} error={account.error} />
      <AccountStatusCards
        overview={account.data}
        balance={officialAccounts.data?.deepseek ?? null}
        opencodeGoUsage={officialAccounts.data?.opencodeGo ?? null}
        freshness={officialAccounts.data?.freshness ?? { deepseek: "missing", opencodeGo: "missing" }}
        refreshingProvider={officialAccounts.refreshingProvider}
        accountError={officialAccounts.refreshError ?? officialAccounts.error ?? officialAccounts.data?.warning ?? null}
        onRefresh={(provider) => void officialAccounts.refresh(provider)}
      />
    </div>
  )
}

function LocalDashboard({
  range,
  onRangeChange,
  data,
  loading,
  error,
}: {
  range: RangeName
  onRangeChange: (range: RangeName) => void
  data: OverviewResponse | null
  loading: boolean
  error: string | null
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <RangeSelector value={range} onChange={onRangeChange} />
      </div>
      <ErrorBanner error={error} />
      {loading || data === null
        ? <PageSkeleton rows={4} />
        : <>
            <GlobalCards global={data.global} />
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
  refreshingProvider,
  accountError,
  onRefresh,
}: {
  overview: ReturnType<typeof useOverview>["data"]
  balance: DeepseekBalanceResponse | null
  opencodeGoUsage: OpencodeGoUsageResponse | null
  freshness: { deepseek: AccountSnapshotFreshness; opencodeGo: AccountSnapshotFreshness }
  refreshingProvider: string | null
  accountError: string | null
  onRefresh: (provider: string) => void
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
            refreshing={refreshingProvider === "deepseek"}
            refreshDisabled={refreshingProvider !== null}
            onRefresh={() => onRefresh("deepseek")}
          />
        </div>
        <div className="flex flex-col gap-2">
          {opencodeGoUsage !== null && opencodeGoUsage.accounts.length > 0
            ? <FreshnessNotice provider="OCG" status={freshness.opencodeGo} />
            : null}
          <OpencodeGoUsageCard
            accounts={opencodeGoUsage?.accounts ?? []}
            refreshingProvider={refreshingProvider}
            refreshDisabled={refreshingProvider !== null}
            onRefresh={onRefresh}
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
        可使用账户卡片上的刷新按钮实时查询。
      </AlertDescription>
    </Alert>
  )
}
