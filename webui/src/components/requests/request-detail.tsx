import { Link, useLocation } from "react-router"
import { Button } from "@/components/ui/button"
import { StatusBadge } from "@/components/metrics/status-badge"
import { Badge } from "@/components/ui/badge"
import { RelayRequestStatus } from "@/components/requests/relay-request-status"
import { useTranslation } from "@/hooks/use-translation"
import { formatElapsedDuration, formatErrorMessage, formatErrorType, formatTimestamp, getServerTimeZone, isClientInterruption } from "@/lib/format"
import { trafficDetailPath } from "@/lib/traffic-state"
import type { RequestRecord } from "@/lib/types"

/** Uses the selected metrics snapshot only; capture is optional and never fetched here. */
export function RequestDetail({ record }: { record: RequestRecord }) {
  const { t, language } = useTranslation()
  const location = useLocation()
  const interrupted = isClientInterruption(record)
  const formatCount = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(language === "zh" ? "zh-CN" : "en-US")
  const uncached = record.inputTokens === null || record.cachedInputTokens === null
    ? null : Math.max(0, record.inputTokens - record.cachedInputTokens)
  const fields = [
    [t("requests.recordedAt"), `${formatTimestamp(record.recordedAtMs)} · ${getServerTimeZone()}`],
    [t("metrics.provider"), record.provider],
    [t("metrics.recordedStatus"), record.status],
    [t("requestDetail.upstreamProvider"), record.upstreamProvider],
    [t("requestDetail.upstreamAttemptCount"), formatCount(record.upstreamAttemptCount)],
    [t("requestDetail.modelAttemptCount"), formatCount(record.modelAttemptCount)],
    [t("requestDetail.finishReason"), record.finishReason],
    [t("requestDetail.errorStage"), record.errorStage === "http" ? t("requestDetail.httpStage") : record.errorStage === "stream" ? t("requestDetail.streamStage") : null],
    [t("requestDetail.upstreamErrorCode"), record.upstreamErrorCode],
    [t("requestDetail.upstreamErrorType"), record.upstreamErrorType],
    [t("requestDetail.upstreamHttpStatus"), record.upstreamHttpStatus],
    [t("requestDetail.requestModel"), record.requestModel],
    [t("requestDetail.responseModel"), record.responseModel],
    ...(record.requestModel === null && record.responseModel === null && record.model !== null
      ? [[t("requestDetail.recordedModel"), record.model]] as const : []),
    [t("metrics.input"), formatCount(record.inputTokens)],
    [t("requestDetail.cached"), formatCount(record.cachedInputTokens)],
    [t("requestDetail.uncached"), formatCount(uncached)],
    [t("metrics.cacheHitRate"), record.cacheHitRate == null ? null : `${(record.cacheHitRate * 100).toFixed(1)}%`],
    [t("metrics.output"), formatCount(record.outputTokens)],
    [t("requests.reasoningColumn"), formatCount(record.reasoningOutputTokens)],
    [t("overview.totalTokens"), formatCount(record.totalTokens)],
    [t("requests.firstColumn"), record.firstTokenMs === null ? null : formatElapsedDuration(record.firstTokenMs)],
    [t("requests.durationColumn"), record.totalDurationMs === null ? null : formatElapsedDuration(record.totalDurationMs)],
    [t("requestDetail.reasoningEffort"), record.reasoningEffort],
    [t("requestDetail.requestTier"), record.requestServiceTier],
    [t("requestDetail.responseTier"), record.serviceTier],
    [t("filters.operation"), record.operation === "compact" ? t("metrics.compact") : t("filters.response")],
    ["HTTP", record.httpStatus],
    [t("requestDetail.transport"), record.transport],
    [t("requestDetail.responseFormat"), record.responseFormat],
    [t("filters.source"), record.source === "relay" ? t("filters.relay") : t("filters.owned")],
    [t("filters.caller"), record.callerDisplayName],
    [t("requestDetail.callerId"), record.callerId],
    [t("filters.delivery"), record.deliveryStatus === "finished" ? t("filters.deliveryFinished")
      : record.deliveryStatus === "disconnected" ? t("filters.deliveryDisconnected")
        : record.deliveryStatus === "failed" ? t("filters.deliveryFailed") : null],
    [t("requestDetail.threadId"), record.threadId],
    [t("requestDetail.turnId"), record.turnId],
    [t("requestDetail.requestId"), record.relayRequestId],
    ["User-Agent", record.userAgent],
  ] as const
  return <div className="flex flex-col gap-4">
    {record.source === "relay" ? <RelayRequestStatus record={record} /> : interrupted ? <Badge variant="secondary">{t("metrics.interrupted")}</Badge> : <StatusBadge status={record.status} />}
    {record.errorType || record.errorCode || record.errorMessage ? <div className="flex flex-col gap-1 break-words" role="note">
      <p>{interrupted ? t("metrics.clientInterruption") : formatErrorType(record.errorType ?? record.errorCode, language)}</p>
      {!interrupted && record.errorMessage ? <p>{formatErrorMessage(record.errorMessage, language)}</p> : null}
      {record.errorCode ? <p>{t("common.errorCode", { code: record.errorCode })}</p> : null}
    </div> : null}
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2">
      {fields.map(([label, value]) => <div key={label} className="contents">
        <dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 whitespace-pre-wrap break-all tabular-nums">{value ?? "—"}</dd>
      </div>)}
    </dl>
    {record.traffic === null ? <p className="text-sm text-muted-foreground">{t("requests.noTrafficReason")}</p>
      : <Button variant="outline" render={<Link to={trafficDetailPath(record.traffic)}
        state={{ requestsReturnTo: `${location.pathname}${location.search}` }} />} nativeButton={false}>{t("requests.viewTraffic")}</Button>}
  </div>
}
