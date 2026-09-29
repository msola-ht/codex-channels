import type { ReactNode } from "react"
import { Link } from "react-router"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { StatusBadge } from "@/components/metrics/status-badge"
import { useTranslation } from "@/hooks/use-translation"
import { formatElapsedDuration, formatErrorType, formatTimestamp } from "@/lib/format"
import { trafficDetailPath } from "@/lib/traffic-state"
import type { RequestDetailResponse } from "@/lib/types"

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex min-w-0 flex-col gap-1">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="min-w-0 break-all whitespace-pre-wrap text-sm">{children}</dd>
  </div>
}

export function RequestDetail({ record }: RequestDetailResponse) {
  const { t, language } = useTranslation()
  const missing = t("requestDetail.missing")
  const value = (item: string | number | null | undefined) => item == null || item === "" ? missing : item
  const tokens = (count: number | null) => count === null ? missing : new Intl.NumberFormat(language).format(count)
  const duration = (ms: number | null) => ms === null ? missing : formatElapsedDuration(ms)
  const delivery = record.deliveryStatus === "finished" ? t("filters.deliveryFinished")
    : record.deliveryStatus === "disconnected" ? t("filters.deliveryDisconnected")
      : record.deliveryStatus === "failed" ? t("filters.deliveryFailed") : missing

  return <div className="grid min-w-0 gap-4 lg:grid-cols-2">
    <Card>
      <CardHeader><CardTitle>{t("requestDetail.identity")}</CardTitle><CardDescription>{t("requestDetail.identityHint")}</CardDescription></CardHeader>
      <CardContent><dl className="grid gap-4 sm:grid-cols-2">
        <DetailField label={t("requestDetail.recordId")}>{record.id}</DetailField>
        <DetailField label={t("filters.source")}>{record.source === "relay" ? t("filters.relay") : t("filters.owned")}</DetailField>
        <DetailField label={t("requestDetail.requestId")}>{value(record.relayRequestId)}</DetailField>
        <DetailField label={t("filters.caller")}>{value(record.callerId)}</DetailField>
        <DetailField label={t("requestDetail.keyId")}>{value(record.keyId)}</DetailField>
        <DetailField label={t("requestDetail.generation")}>{value(record.credentialGeneration)}</DetailField>
        <DetailField label={t("metrics.provider")}><ProviderBadge provider={record.provider} /></DetailField>
        <DetailField label={t("requestDetail.requestModel")}>{value(record.requestModel)}</DetailField>
        <DetailField label={t("requestDetail.responseModel")}>{value(record.responseModel)}</DetailField>
        <DetailField label={t("requestDetail.userAgent")}>{value(record.userAgent)}</DetailField>
      </dl></CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t("requestDetail.result")}</CardTitle><CardDescription>{t("requestDetail.resultHint")}</CardDescription></CardHeader>
      <CardContent><dl className="grid gap-4 sm:grid-cols-2">
        <DetailField label={t("requestDetail.modelStatus")}><StatusBadge status={record.status} /></DetailField>
        <DetailField label={t("filters.delivery")}>{delivery}</DetailField>
        <DetailField label={t("requestDetail.upstreamHttp")}>{value(record.httpStatus)}</DetailField>
        <DetailField label={t("requestDetail.responseFormat")}>{record.responseFormat === "unknown" ? missing : record.responseFormat.toUpperCase()}</DetailField>
        <DetailField label={t("requestDetail.errorCode")}>{value(record.errorCode)}</DetailField>
        <DetailField label={t("requestDetail.errorType")}>{record.errorType ? formatErrorType(record.errorType, language) : missing}</DetailField>
        <DetailField label={t("requestDetail.started")}>{formatTimestamp(record.requestStartedAtMs)}</DetailField>
        <DetailField label={t("requestDetail.completed")}>{formatTimestamp(record.responseCompletedAtMs)}</DetailField>
        <DetailField label={t("requestDetail.recorded")}>{formatTimestamp(record.recordedAtMs)}</DetailField>
      </dl></CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t("requestDetail.usage")}</CardTitle><CardDescription>{t("requestDetail.usageHint")}</CardDescription></CardHeader>
      <CardContent><dl className="grid gap-4 sm:grid-cols-2">
        <DetailField label={t("metrics.input")}>{tokens(record.inputTokens)}</DetailField>
        <DetailField label={t("requestDetail.cached")}>{tokens(record.cachedInputTokens)}</DetailField>
        <DetailField label={t("metrics.output")}>{tokens(record.outputTokens)}</DetailField>
        <DetailField label={t("requests.reasoningColumn")}>{tokens(record.reasoningOutputTokens)}</DetailField>
        <DetailField label={t("overview.totalTokens")}>{tokens(record.totalTokens)}</DetailField>
        <DetailField label={t("requests.firstColumn")}>{duration(record.firstTokenMs)}</DetailField>
        <DetailField label={t("requests.durationColumn")}>{duration(record.totalDurationMs)}</DetailField>
      </dl></CardContent>
    </Card>
    <Card>
      <CardHeader><CardTitle>{t("requestDetail.associations")}</CardTitle><CardDescription>{record.source === "relay" ? t("requestDetail.relayScope") : t("requestDetail.ownedScope")}</CardDescription></CardHeader>
      <CardContent><dl className="grid gap-4 sm:grid-cols-2">
        <DetailField label={t("requestDetail.threadId")}>{value(record.threadId)}</DetailField>
        <DetailField label={t("requestDetail.turnId")}>{value(record.turnId)}</DetailField>
        <DetailField label={t("requestDetail.traffic")}>{record.traffic == null ? missing : <Button variant="link" size="sm" asChild>
          <Link to={trafficDetailPath(record.traffic)}>{t("requestDetail.viewTraffic")}</Link>
        </Button>}</DetailField>
      </dl></CardContent>
    </Card>
  </div>
}
