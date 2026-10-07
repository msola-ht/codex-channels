import { useState, type ReactNode } from "react"
import { formatGenerationSpeed } from "../../../../runtime/request-timing.mjs"
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import { TrafficParameterComparison, TrafficRequestContent } from "@/components/traffic/traffic-request-content"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { TrafficContent, TrafficDisclosure } from "@/components/traffic/traffic-content"
import { TableHint } from "@/components/metrics/data-table"
import { FastBadge } from "@/components/metrics/service-tier"
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatBytes, formatTime, formatElapsedDuration } from "@/lib/format"
import type { TrafficExchangeDetail, TrafficHeaderValue } from "@/lib/types"
import type { Translate } from "@/lib/i18n/messages"
import { useTranslation } from "@/hooks/use-translation"

export function TrafficDetail({
  detail,
  provider,
  session,
  onTracePageChange,
  traceLoading = false,
  traceError = false,
  onRetry,
}: {
  detail: TrafficExchangeDetail
  provider: string
  session: string
  onTracePageChange: (offset: number) => void
  traceLoading?: boolean
  traceError?: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation()
  const finalProvider = detail.upstreamProvider ?? detail.chatDiagnostics?.fields["routing.finalProvider"]
  const autoReview = detail.requestPurpose === "autoApprovalReview"
  const [copyState, setCopyState] = useState<"idle" | "pending" | "copied" | "failed">("idle")
  const copyReference = async () => {
    setCopyState("pending")
    try {
      await navigator.clipboard.writeText(JSON.stringify({ label: provider, session, id: detail.id }, null, 2))
      setCopyState("copied")
    } catch {
      setCopyState("failed")
    }
  }
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4">
      <Card size="sm" aria-label={t("traffic.overviewAria")}>
        <CardHeader>
          <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
            <TrafficModel provider={["relay.chat", "relay.responses"].includes(provider) ? detail.account : provider} request={detail.requestModel} responses={detail.responseModels} upstream={typeof finalProvider === "string" ? finalProvider : undefined} />
            <Badge variant="outline">{detail.category === "models" ? t("traffic.categoryModels") : detail.category === "prewarm" ? t("traffic.categoryPrewarm") : t("traffic.categoryRequest")}</Badge>
            {autoReview ? <Badge variant="outline">{t("requestPurpose.autoApprovalReview")}</Badge> : null}
          </CardTitle>
          <CardDescription className="flex min-w-0 flex-wrap items-center gap-2">
            <span>{formatTime(detail.startedAtMs)} · {provider}</span>
            {detail.account === undefined ? null : <Badge variant="outline">{detail.account}</Badge>}
          </CardDescription>
          <CardAction><StateBadge state={detail.state} /></CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
            {[
              [t("requestPurpose.label"), autoReview ? t("requestPurpose.autoApprovalReview") : null],
              [t(autoReview ? "requestPurpose.ownerThread" : "traffic.fieldThread"), detail.threadId],
              [t(autoReview ? "requestPurpose.ownerTurn" : "traffic.fieldTurn"), detail.turnId],
              ...(autoReview ? [[t("requestPurpose.reviewerThread"), detail.reviewerThreadId], [t("requestPurpose.reviewerTurn"), detail.reviewerTurnId]] : []),
            ].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value ?? "—"}</dd></div>)}
          </dl>
          <CallSummary detail={detail} />
        </CardContent>
      </Card>
      {traceLoading ? <p role="status" className="text-sm text-muted-foreground">{t("traffic.refreshingTrace")}</p> : null}
      {detail.response === null ? (
        <Card size="sm" aria-label={t("filters.response")}>
          <CardHeader><CardTitle>{t(detail.debug ? "traffic.debugUpstream" : "filters.response")}</CardTitle></CardHeader>
          <CardContent><Empty><EmptyHeader><EmptyTitle>{t("traffic.statePending")}</EmptyTitle><EmptyDescription>{t("traffic.noTerminalDescription")}</EmptyDescription></EmptyHeader></Empty></CardContent>
        </Card>
      ) : (
        <Card size="sm" className="min-w-0 shrink-0">
          <CardHeader>
            <CardTitle>{t(detail.debug ? "traffic.debugUpstream" : "filters.response")}</CardTitle>
            <CardDescription>{[detail.response.status === null ? null : `HTTP ${detail.response.status}`, detail.response.eventType].filter(Boolean).join(" · ") || t("traffic.savedResponse")}</CardDescription>
          </CardHeader>
            <CardContent className="flex flex-col gap-3">
            {["redacted_upstream_chat", "redacted_upstream_responses"].includes(detail.response.capture ?? "") ? <Alert>
              <AlertTitle>{t("traffic.relayCapture")}</AlertTitle>
              <AlertDescription>{t("traffic.relayCaptureHint")} · {detail.response.deliveryStatus === "finished"
                ? t("filters.deliveryFinished") : detail.response.deliveryStatus === "disconnected"
                  ? t("filters.deliveryDisconnected") : t("filters.deliveryFailed")}</AlertDescription>
            </Alert> : null}
            <ResponseFailure response={detail.response} diagnostics={detail.chatDiagnostics} />
            {detail.response.output.map((item, index) => (
              <TrafficContent key={index} title={outputLabel(t, item)} text={item.text} />
            ))}
            {detail.response.output.length === 0 ? (
              <Empty><EmptyHeader><EmptyTitle>{detail.category === "prewarm" ? t("traffic.categoryPrewarm") : detail.category === "models" ? t("traffic.categoryModels") : t("traffic.outputMissing")}</EmptyTitle>
                <EmptyDescription>{detail.category === "prewarm" ? t("traffic.prewarmNoOutput") : t("traffic.outputEmptyHint")}</EmptyDescription>
              </EmptyHeader></Empty>
            ) : null}
            {detail.response.outputTruncated ? (
              <Alert><AlertTitle>{t("traffic.outputTruncatedTitle")}</AlertTitle><AlertDescription>{t("traffic.outputTruncatedDescription")}</AlertDescription></Alert>
            ) : null}
            <TrafficDisclosure title={`${t("traffic.responseRawTitle")}${detail.response.bodyTruncated ? t("traffic.truncatedSuffix") : ""}`}>
              <div className="flex min-w-0 flex-col gap-3">
                <p className="flex items-center gap-2 text-sm">{t("traffic.responseServiceTier", { value: detail.response.serviceTier ?? t("modelComparison.notProvided") })}<FastBadge tier={detail.response.serviceTier} source="response" /></p>
                {detail.response.responseId === undefined ? null : (
                  <p className="break-all font-mono text-xs text-muted-foreground">{t("traffic.responseId", { id: detail.response.responseId })}</p>
                )}
                {detail.response.bytes === undefined && detail.response.storedBytes === undefined ? null : <p className="text-xs text-muted-foreground">{[detail.response.bytes === undefined || ["redacted_upstream_chat", "redacted_upstream_responses"].includes(detail.response.capture ?? "") ? null : t("traffic.transferred", { size: formatBytes(detail.response.bytes) }), detail.response.storedBytes === undefined ? null : t("traffic.stored", { size: formatBytes(detail.response.storedBytes) })].filter(Boolean).join(" · ")}</p>}
                <HeaderTable title={t("traffic.responseHeadersTitle")} headers={detail.response.headers} truncated={detail.response.headersTruncated} />
                <TrafficContent title={t("traffic.responseBodyRawTitle")} text={detail.response.body} json truncated={detail.response.bodyTruncated} />
              </div>
            </TrafficDisclosure>
          </CardContent>
        </Card>
      )}

      <Card size="sm" className="min-w-0 shrink-0">
        <CardHeader>
          <CardTitle>{t(detail.debug ? "traffic.debugOutbound" : "metrics.requests")}</CardTitle>
          <CardDescription className="break-all">
            {requestLabel(detail)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 text-sm">
            <span>{t("traffic.reasoningEffort", { value: detail.request.parameters.reasoningEffort ?? t("modelComparison.notProvided") })}</span>
            <span className="inline-flex items-center gap-2">{t("traffic.requestServiceTier", { value: detail.request.parameters.serviceTier ?? t("modelComparison.notProvided") })}<FastBadge tier={detail.request.parameters.serviceTier} source="request" /></span>
            {detail.request.parameters.generate === false ? <Badge variant="outline">{t("traffic.noOutputBadge")}</Badge> : null}
          </div>
          <TrafficRequestContent content={detail.request.content} />
          <TrafficDisclosure title={`${t("traffic.requestRawTitle")}${detail.request.bodyTruncated ? t("traffic.truncatedSuffixParen") : ""}`}>
            <div className="flex min-w-0 flex-col gap-3">
              {detail.request.parameters.previousResponseId === undefined ? null : (
                <p className="break-all font-mono text-xs text-muted-foreground">{t("traffic.previousResponseId", { id: detail.request.parameters.previousResponseId })}</p>
              )}
              {detail.request.bytes === undefined && detail.request.storedBytes === undefined ? null : <p className="text-xs text-muted-foreground">{[detail.request.bytes === undefined ? null : t("traffic.requestBytesRaw", { size: formatBytes(detail.request.bytes) }), detail.request.storedBytes === undefined ? null : t("traffic.stored", { size: formatBytes(detail.request.storedBytes) })].filter(Boolean).join(" · ")}</p>}
              <HeaderTable title={t("traffic.requestHeadersTitle")} headers={detail.request.headers} truncated={detail.request.headersTruncated} />
              <TrafficContent title={t("traffic.requestBodyTitle")} text={detail.request.body} json truncated={detail.request.bodyTruncated} />
            </div>
          </TrafficDisclosure>
        </CardContent>
      </Card>

      {detail.debug ? <Card size="sm">
        <CardHeader><CardTitle>{t("traffic.debugTitle")}</CardTitle><CardDescription>{t("traffic.debugNote")}</CardDescription></CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          {(["inbound", "delivered"] as const).map(stage => {
            const record = detail.debug![stage]
            return <TrafficDisclosure key={stage} title={t(stage === "inbound" ? "traffic.debugInbound" : "traffic.debugDelivered")}>
              {record ? <div className="flex min-w-0 flex-col gap-3">
                {record.state ? <p>{t(`traffic.debugState.${record.state}`)}{record.status === undefined ? "" : ` · HTTP ${record.status}`}</p> : null}
                <HeaderTable title={t(stage === "inbound" ? "traffic.requestHeadersTitle" : "traffic.responseHeadersTitle")} headers={record.headers} truncated={record.headersTruncated} />
                <TrafficContent title={t(stage === "inbound" ? "traffic.requestBodyTitle" : "traffic.responseBodyRawTitle")} text={record.body} json truncated={record.bodyTruncated} />
              </div> : <p>{t("traffic.notRecorded")}</p>}
            </TrafficDisclosure>
          })}
          <TrafficDisclosure title={t("traffic.debugChanges")}>
            {detail.debug.transformations.map(change => <p key={change}>{t(`traffic.debugChange.${change}`)}</p>)}
          </TrafficDisclosure>
        </CardContent>
      </Card> : null}

      <Card size="sm" aria-label={t("traffic.diagnosticsTitle")}>
        <CardHeader><CardTitle>{t("traffic.diagnosticsTitle")}</CardTitle><CardDescription>{t("traffic.diagnosticsDescription")}</CardDescription></CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <TrafficDisclosure title={t("traffic.recordInfoTitle")}>
            <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
              {[[t("traffic.provider"), provider], [t("traffic.fieldSession"), session], [t("traffic.fieldCallId"), `#${detail.id}`], [t("traffic.fieldRequestKind"), detail.requestKind], [t("traffic.fieldTransport"), requestLabel(detail)]].map(([label, value]) => (
                <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value ?? "—"}</dd></div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={copyState === "pending"} onClick={() => void copyReference()}><CopyIcon data-icon="inline-start" />{t("traffic.copyReference")}</Button>
              <span role="status" className="text-xs text-muted-foreground">{copyState === "copied" ? t("traffic.referenceCopied") : copyState === "failed" ? t("traffic.referenceCopyFailed") : ""}</span>
            </div>
          </TrafficDisclosure>
          {detail.response?.state === "completed" && hasResponseDiagnostics(detail.response) ? <TrafficDisclosure title={t("traffic.postCompleteDiagnosticsTitle")}>
            <p className="text-sm text-muted-foreground">{t("traffic.postCompleteDiagnosticsNote")}</p>
            <ResponseErrorDetails response={detail.response} />
          </TrafficDisclosure> : null}
          {detail.chatDiagnostics ? <TrafficDisclosure title={t("traffic.chatUpstreamTitle")}>
            <p className="text-sm">{t("traffic.chatUpstreamSummary", { provider: String(detail.chatDiagnostics.fields["routing.finalProvider"] ?? t("modelComparison.notProvided")), model: String(detail.chatDiagnostics.fields.model ?? t("modelComparison.notProvided")) })}</p>
            <p className="text-xs text-muted-foreground">{t("traffic.chatUpstreamNote")}</p>
            <TrafficContent title={t("traffic.chatUpstreamFieldsTitle")} text={JSON.stringify(detail.chatDiagnostics.fields, null, 2)} json />
            {detail.chatDiagnostics.truncated ? <p className="text-xs text-muted-foreground">{t("traffic.chatUpstreamTruncated")}</p> : null}
          </TrafficDisclosure> : null}

          <TrafficDisclosure title={t("traffic.modelEvidenceTitle")}><ModelEvidence detail={detail} /></TrafficDisclosure>
          <TrafficParameterComparison rows={detail.parameterComparison} />
          {detail.tracePage.total === 0 ? null : (
            <TrafficDisclosure title={t("traffic.traceTitle", { count: detail.tracePage.total })}>
              <div className="flex min-w-0 flex-col gap-3" aria-busy={traceLoading}>
                {traceLoading ? <><p role="status">{t("traffic.traceLoading")}</p><Skeleton className="h-32 w-full" /></> : traceError ? <><p>{t("traffic.traceError")}</p><Button type="button" variant="outline" onClick={onRetry}>{t("traffic.traceRetry")}</Button></> : <><p className="text-xs text-muted-foreground">{t("traffic.traceRange", { from: detail.tracePage.offset + 1, to: detail.tracePage.offset + detail.trace.length, total: detail.tracePage.total })}</p>{detail.trace.map((item, index) => (
                  <section key={`${item.atMs}-${item.kind}-${index}`} className="flex min-w-0 flex-col gap-1">
                    <p className="font-mono text-xs text-muted-foreground">
                      {formatTime(item.atMs)} [{item.kind}]{item.truncated ? t("traffic.truncatedInline") : ""}
                    </p>
                    <TrafficContent title={t("traffic.traceItemTitle")} text={item.text} json truncated={item.truncated} />
                  </section>
                ))}</>}
                {detail.tracePage.previousOffset === null && detail.tracePage.nextOffset === null ? null : (
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={traceLoading || traceError || detail.tracePage.previousOffset === null}
                      onClick={() => detail.tracePage.previousOffset === null
                        ? undefined
                        : onTracePageChange(detail.tracePage.previousOffset)}
                    >
                      <ChevronLeftIcon data-icon="inline-start" />{t("common.previous")}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={traceLoading || traceError || detail.tracePage.nextOffset === null}
                      onClick={() => detail.tracePage.nextOffset === null
                        ? undefined
                        : onTracePageChange(detail.tracePage.nextOffset)}
                    >
                      {t("common.next")}<ChevronRightIcon data-icon="inline-end" />
                    </Button>
                  </div>
                )}
              </div>
            </TrafficDisclosure>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StateBadge({ state }: { state: TrafficExchangeDetail["state"] }) {
  const { t } = useTranslation()
  const label = state === "completed" ? t("traffic.stateCompleted") : state === "failed" ? t("traffic.stateFailed")
    : state === "incomplete" ? t("traffic.stateIncomplete") : t("traffic.statePending")
  return <Badge variant={state === "completed" ? "secondary" : state === "pending" ? "outline" : "destructive"}>{label}</Badge>
}

function CallSummary({ detail }: { detail: TrafficExchangeDetail }) {
  const { t } = useTranslation()
  const usage = detail.response?.usage
  const isModel = detail.category !== "models" && detail.category !== "prewarm"
  const rate = usage?.inputTokens !== undefined && usage.inputTokens > 0 && usage.cachedTokens !== undefined
    ? `${(usage.cachedTokens / usage.inputTokens * 100).toFixed(1)}%` : "—"
  const elapsed = (value: number | undefined) => value === undefined ? "—" : formatElapsedDuration(value)
  return <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
    {isModel ? <SummaryMetric label={<TableHint hint={t("requests.firstHint")}>{t("requests.firstColumn")}</TableHint>} value={elapsed(detail.response?.firstTokenMs)} /> : null}
    {isModel ? <SummaryMetric label={<TableHint hint={t("requests.speedHint")}>{t("requests.speedColumn")}</TableHint>} value={formatGenerationSpeed({ ...detail.response, status: detail.response?.state, totalDurationMs: detail.response?.durationMs })} /> : null}
    <SummaryMetric label={t("requests.durationColumn")} value={elapsed(detail.response?.durationMs)} />
    {isModel ? <>
      <SummaryMetric label={t("metrics.input")} value={usage?.inputTokens?.toLocaleString() ?? "—"} description={usage?.cachedTokens === undefined ? undefined : t("traffic.cachedTokens", { count: usage.cachedTokens.toLocaleString(), rate })} />
      <SummaryMetric label={t("metrics.output")} value={usage?.outputTokens?.toLocaleString() ?? "—"} description={usage?.reasoningTokens === undefined ? undefined : t("traffic.reasoningTokens", { count: usage.reasoningTokens.toLocaleString() })} />
    </> : null}
  </dl>
}

function SummaryMetric({ label, value, description }: { label: ReactNode; value: string; description?: string }) {
  return <div className="flex min-w-0 flex-col gap-1">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="tabular-nums">{value}</dd>
    {description === undefined ? null : <dd className="text-xs text-muted-foreground tabular-nums">{description}</dd>}
  </div>
}

function ResponseFailure({ response, diagnostics }: { response: NonNullable<TrafficExchangeDetail["response"]>; diagnostics?: TrafficExchangeDetail["chatDiagnostics"] }) {
  const { t } = useTranslation()
  if (response.state === "completed") return null
  const fields = diagnostics?.fields ?? {}
  const codes = [fields["upstreamError.cause.type"], fields["upstreamError.cause.code"], fields["upstreamError.type"], fields["upstreamError.code"], fields["error.code"], response.error]
  const reasons = {
    rate_limit_exceeded: "rateLimit", rate_limit: "rateLimit", rate_limit_reached: "rateLimit",
    authentication_error: "authentication", permission_denied: "permission", payment_required: "payment",
    context_length_exceeded: "context", content_filter: "content", server_error: "server",
    upstream_timeout: "timeout", request_timeout: "timeout", invalid_request_error: "invalid", not_found: "notFound",
  } as const
  const statusReasons = { 400: "invalid", 401: "authentication", 402: "payment", 403: "permission", 404: "notFound", 429: "rateLimit", 500: "server", 502: "server", 503: "server", 504: "timeout" } as const
  const known = codes.find((code): code is keyof typeof reasons => typeof code === "string" && Object.hasOwn(reasons, code))
  const status = fields["upstreamError.cause.statusCode"] ?? response.status
  const reason = known ? reasons[known] : typeof status === "number" && Object.hasOwn(statusReasons, status) ? statusReasons[status as keyof typeof statusReasons] : "unknown"
  const facts = [
    [t("traffic.failureUpstreamCode"), fields["upstreamError.code"]],
    [t("traffic.failureCause"), fields["upstreamError.cause.type"] ?? fields["upstreamError.cause.code"] ?? fields["upstreamError.type"]],
    [t("traffic.failureUpstreamStatus"), fields["upstreamError.cause.statusCode"]],
    [t("traffic.failureRequestId"), fields["upstreamError.request_id"] ?? fields.requestId],
  ]
  return <Alert variant="destructive">
    <AlertTitle>{response.state === "incomplete" ? t("traffic.responseIncomplete") : t("traffic.requestFailed")}</AlertTitle>
    <AlertDescription className="min-w-0">
      <p>{t(`traffic.failureReasons.${reason}`)}</p>
      {facts.filter(([, value]) => value !== undefined).map(([label, value]) => <p key={String(label)} className="break-all">{label}: {String(value)}</p>)}
      {response.failureStage === undefined ? null : <p>{t("traffic.failureStage", { stage: response.failureStage })}</p>}
      {response.failure === undefined && response.error === undefined && response.errorScope === undefined
        ? <p>{t("traffic.failureUnknown")}</p>
        : <TrafficDisclosure title={t("traffic.errorDetailsTitle")}><ResponseErrorDetails response={response} /></TrafficDisclosure>}
    </AlertDescription>
  </Alert>
}

function hasResponseDiagnostics(response: NonNullable<TrafficExchangeDetail["response"]>) {
  return response.failureStage !== undefined || response.failure !== undefined || response.errorScope !== undefined || response.error !== undefined
}

function ResponseErrorDetails({ response }: { response: NonNullable<TrafficExchangeDetail["response"]> }) {
  const { t } = useTranslation()
  return <TrafficContent title={t("traffic.rawDiagnosticsTitle")} text={JSON.stringify({ stage: response.failureStage, reason: response.failure, scope: response.errorScope, error: response.error }, null, 2)} json />
}

function outputLabel(t: Translate, item: NonNullable<TrafficExchangeDetail["response"]>["output"][number]): string {
  if (item.type === "message") return item.phase === "commentary" ? t("traffic.outputCommentary") : t("traffic.outputAnswer")
  if (item.type === "reasoning") return t("traffic.outputReasoning")
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return t("traffic.outputToolCall", { name: item.name ?? t("traffic.unknownName"), id: item.callId === undefined ? "" : ` · ${item.callId}` })
  }
  return item.type
}

function requestLabel(detail: TrafficExchangeDetail): string {
  if (detail.transport === "websocket") return `WebSocket ${detail.request.url ?? detail.url ?? ""}`
  return `${detail.request.method ?? "HTTP"} ${detail.request.path ?? ""}`.trim()
}

function HeaderTable({ title, headers, truncated }: { title: string; headers: Record<string, TrafficHeaderValue>; truncated?: boolean }) {
  const { t } = useTranslation()
  const entries = Object.entries(headers)
  if (entries.length === 0 && !truncated) return null
  return (
    <section className="flex flex-col gap-1">
      <p className="break-all text-xs font-medium">{title}</p>
      {truncated ? <p className="text-xs text-muted-foreground">{t("traffic.debugHeadersTruncated")}</p> : null}
      <div className="rounded-md border bg-muted/50 p-3 font-mono text-xs">
        {entries.map(([name, value]) => (
          <p key={name} className="break-all">{name}: {Array.isArray(value) ? value.join(", ") : value}</p>
        ))}
      </div>
    </section>
  )
}

function ModelEvidence({ detail }: { detail: TrafficExchangeDetail }) {
  const { t } = useTranslation()
  return <section className="flex min-w-0 flex-col gap-3 text-sm">
      <p className="text-muted-foreground">{t("traffic.modelEvidenceNote")}</p>
      <p className="break-all">{t("traffic.requestModel", { name: detail.requestModel ?? t("modelComparison.notProvided") })}</p>
      <p className="break-all">{t("traffic.responseModels", { names: detail.responseModels.join(t("modelComparison.listSeparator")) || t("modelComparison.notProvided") })}</p>
      <p>{t("traffic.serverModelsTitle")}</p>
      {detail.modelEvidence.serverModels.length === 0 ? <p>{t("traffic.notRecorded")}</p> : detail.modelEvidence.serverModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{t("traffic.modelWithSource", { model: entry.model, source: entry.source })}</p>)}
      <p>{t("traffic.safetyModelsTitle")}</p>
      {detail.modelEvidence.safetyModels.length === 0 ? <p>{t("traffic.notRecorded")}</p> : detail.modelEvidence.safetyModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{t("traffic.modelWithSource", { model: entry.model, source: entry.source })}</p>)}
      <p>{t("traffic.turnStateLengthsTitle")}</p>
      {detail.modelEvidence.turnStateLengths.length === 0 ? <p>{t("traffic.notRecorded")}</p> : detail.modelEvidence.turnStateLengths.map((entry) => <p className="break-all" key={`${entry.source}:${entry.characters}`}>{t("traffic.turnStateWithSource", { count: entry.characters.toLocaleString("zh-CN"), source: entry.source })}</p>)}
      {detail.modelEvidence.truncated ? <p>{t("traffic.modelEvidenceTruncated")}</p> : null}
  </section>
}
