import { useState } from "react"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { RangeSelector } from "@/components/metrics/range-selector"
import {
  ErrorsSummary,
  GlobalCards,
  ProviderTable,
  WeeklyQuotaCard,
} from "@/components/overview/overview-sections"
import { useOverview } from "@/hooks/use-overview"
import { useCurrency } from "@/hooks/currency-context"
import type { RangeName } from "@/lib/types"

export function OverviewPage() {
  const [range, setRange] = useState<RangeName>("24h")
  const { currency } = useCurrency()
  const { data, loading, error } = useOverview(range)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">概览</h1>
          <p className="text-sm text-muted-foreground">全局模型请求指标与参考费用</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <RangeSelector value={range} onChange={setRange} />
        </div>
      </div>

      <ErrorBanner error={error} />

      {loading || data === null
        ? <PageSkeleton rows={4} />
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
