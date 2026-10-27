import type { ReactNode } from "react"
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { useCloudUsage } from "@/hooks/use-cloud-usage"
import { useTranslation } from "@/hooks/use-translation"
import { formatTokens } from "@/lib/format"
import { translateApiErrorCode } from "@/lib/i18n/translate"

export function OllamaCloudUsageCard({ provider, title }: { provider: string; title: ReactNode }) {
  const { t } = useTranslation()
  const usage = useCloudUsage(provider)
  const report = usage.data?.report
  const estimates = usage.data?.estimates
  const unknown = t("overview.creditNotProvided")
  const tokens = (value: number | null) => value === null ? unknown : `${value === 0 ? "0" : formatTokens(value)} Token`
  const usd = (value: string | null) => value === null ? unknown : `$${value}`
  const plan = report?.plan === "pro" ? "Pro" : report?.plan === "max" ? "Max" : report?.plan === "free" ? "Free" : report?.plan ?? unknown
  const refreshLabel = t(usage.loading ? "common.refreshing" : usage.errorCode ? "common.retry" : "common.refresh")

  return <Card size="sm" aria-busy={usage.loading}>
    <CardHeader className="flex flex-row items-start justify-between gap-3">
      <CardTitle className="flex flex-wrap items-center gap-2">
        {title}
        {report ? <Badge variant="outline" aria-label={`${t("cloudUsage.plan")} ${plan}`}>{plan}</Badge> : null}
      </CardTitle>
      <Button variant="outline" size="icon-sm" disabled={usage.loading} onClick={usage.refresh} aria-label={refreshLabel} title={refreshLabel}>
        {usage.loading ? <Spinner /> : <RefreshCwIcon />}
      </Button>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      {report ? <dl className="grid grid-cols-2 gap-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("cloudUsage.allowance")}</dt>
          <dd className="break-words text-2xl font-semibold tabular-nums">{usd(report.allowanceUsd)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">{t("cloudUsage.balance")}</dt>
          <dd className="break-words text-2xl font-semibold tabular-nums">{usd(report.balanceUsd)}</dd>
        </div>
      </dl> : usage.loading ? <div className="grid grid-cols-2 gap-3" aria-label={t("overview.accountLoadingData")}>
        <Skeleton className="h-14" /><Skeleton className="h-14" />
      </div> : null}

      {usage.errorCode ? <Alert variant={report ? "default" : "destructive"}>
        <AlertCircleIcon />
        <AlertTitle>{t("overview.refreshFailedTitle")}</AlertTitle>
        <AlertDescription>
          <p>{translateApiErrorCode(t, usage.errorCode)}</p>
          <p>{t(report ? "overview.refreshFailedKeepsSnapshot" : "overview.refreshFailedNoSnapshot")}</p>
        </AlertDescription>
      </Alert> : null}

      {report && estimates ? <>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">{t("cloudUsage.unitEstimate", { tokens: formatTokens(estimates.priceTokens) })}</dt>
          <dd className="break-words text-right tabular-nums">
            {usd(estimates.priceUsd)}{estimates.proMonthly ? ` · ${estimates.priceCny === null ? unknown : `¥${estimates.priceCny}`}` : ""}
          </dd>
          <dt className="text-muted-foreground">{t("cloudUsage.allowanceEstimate")}</dt>
          <dd className="break-words text-right tabular-nums">{tokens(estimates.allowanceTokens)}</dd>
          <dt className="text-muted-foreground">{t("cloudUsage.remainingEstimate")}</dt>
          <dd className="break-words text-right tabular-nums">{tokens(estimates.remainingTokens)}</dd>
        </dl>
        {report.stale || report.balanceStale || report.planStale ? <p className="text-xs text-muted-foreground">{t("cloudUsage.stale")}</p> : null}
      </> : null}
    </CardContent>
  </Card>
}
