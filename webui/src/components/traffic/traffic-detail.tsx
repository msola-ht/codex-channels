import { useState, type ReactNode } from "react"
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
  const finalProvider = detail.chatDiagnostics?.fields["routing.finalProvider"]
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
      <Card size="sm" aria-label="调用概览">
        <CardHeader>
          <CardTitle className="flex min-w-0 flex-wrap items-center gap-2">
            <TrafficModel provider={provider} request={detail.requestModel} responses={detail.responseModels} upstream={typeof finalProvider === "string" ? finalProvider : undefined} />
            <Badge variant="outline">{detail.category === "models" ? "模型列表" : detail.category === "prewarm" ? "连接预热" : "模型请求"}</Badge>
          </CardTitle>
          <CardDescription className="flex min-w-0 flex-wrap items-center gap-2">
            <span>{formatTime(detail.startedAtMs)} · {provider}</span>
            {detail.account === undefined ? null : <Badge variant="outline">{detail.account}</Badge>}
          </CardDescription>
          <CardAction><StateBadge state={detail.state} /></CardAction>
        </CardHeader>
        <CardContent><CallSummary detail={detail} /></CardContent>
      </Card>
      {traceLoading ? <p role="status" className="text-sm text-muted-foreground">正在刷新调用记录，当前摘要为上次成功读取的内容。</p> : null}
      {detail.response === null ? (
        <Card size="sm" aria-label="响应">
          <CardHeader><CardTitle>响应</CardTitle></CardHeader>
          <CardContent><Empty><EmptyHeader><EmptyTitle>未记录终态</EmptyTitle><EmptyDescription>当前记录没有终态响应，无法据此判断请求是否仍在运行。可刷新查看。</EmptyDescription></EmptyHeader></Empty></CardContent>
        </Card>
      ) : (
        <Card size="sm" className="min-w-0 shrink-0">
          <CardHeader>
            <CardTitle>响应</CardTitle>
            <CardDescription>{[detail.response.status === null ? null : `HTTP ${detail.response.status}`, detail.response.eventType].filter(Boolean).join(" · ") || "已保存的响应内容"}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ResponseFailure response={detail.response} />
            {detail.response.output.map((item, index) => (
              <TrafficContent key={index} title={outputLabel(item)} text={item.text} />
            ))}
            {detail.response.output.length === 0 ? (
              <Empty><EmptyHeader><EmptyTitle>{detail.category === "prewarm" ? "连接预热" : detail.category === "models" ? "模型列表" : "未提取到输出"}</EmptyTitle>
                <EmptyDescription>{detail.category === "prewarm" ? "本次请求不生成回答。" : "可展开原始响应查看已保存的内容。"}</EmptyDescription>
              </EmptyHeader></Empty>
            ) : null}
            {detail.response.outputTruncated ? (
              <Alert><AlertTitle>输出展示不完整</AlertTitle><AlertDescription>输出超出展示上限，或传输记录残缺、无法解析。原始调用记录未被修改。</AlertDescription></Alert>
            ) : null}
            <TrafficDisclosure title={`响应头与原始响应${detail.response.bodyTruncated ? " · 展示已截断" : ""}`}>
              <div className="flex min-w-0 flex-col gap-3">
                <p className="flex items-center gap-2 text-sm">响应服务层级：{detail.response.serviceTier ?? "未提供"}<FastBadge tier={detail.response.serviceTier} source="response" /></p>
                {detail.response.responseId === undefined ? null : (
                  <p className="break-all font-mono text-xs text-muted-foreground">响应 ID：{detail.response.responseId}</p>
                )}
                {detail.response.bytes === undefined && detail.response.storedBytes === undefined ? null : <p className="text-xs text-muted-foreground">{[detail.response.bytes === undefined ? null : `传输 ${formatBytes(detail.response.bytes)}`, detail.response.storedBytes === undefined ? null : `存储 ${formatBytes(detail.response.storedBytes)}`].filter(Boolean).join(" · ")}</p>}
                <HeaderTable title="响应头" headers={detail.response.headers} />
                <TrafficContent title="原始终态" text={detail.response.body} json truncated={detail.response.bodyTruncated} />
              </div>
            </TrafficDisclosure>
          </CardContent>
        </Card>
      )}

      <Card size="sm" className="min-w-0 shrink-0">
        <CardHeader>
          <CardTitle>请求</CardTitle>
          <CardDescription className="break-all">
            {requestLabel(detail)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 text-sm">
            <span>思考等级：{detail.request.parameters.reasoningEffort ?? "未提供"}</span>
            <span className="inline-flex items-center gap-2">请求服务层级：{detail.request.parameters.serviceTier ?? "未提供"}<FastBadge tier={detail.request.parameters.serviceTier} source="request" /></span>
            {detail.request.parameters.generate === false ? <Badge variant="outline">不生成输出</Badge> : null}
          </div>
          <TrafficRequestContent content={detail.request.content} />
          <TrafficDisclosure title={`请求头与原始正文${detail.request.bodyTruncated ? "（展示已截断）" : ""}`}>
            <div className="flex min-w-0 flex-col gap-3">
              {detail.request.parameters.previousResponseId === undefined ? null : (
                <p className="break-all font-mono text-xs text-muted-foreground">接续响应：{detail.request.parameters.previousResponseId}</p>
              )}
              {detail.request.bytes === undefined && detail.request.storedBytes === undefined ? null : <p className="text-xs text-muted-foreground">{[detail.request.bytes === undefined ? null : `原始 ${formatBytes(detail.request.bytes)}`, detail.request.storedBytes === undefined ? null : `存储 ${formatBytes(detail.request.storedBytes)}`].filter(Boolean).join(" · ")}</p>}
              <HeaderTable title="请求头" headers={detail.request.headers} />
              <TrafficContent title="请求正文" text={detail.request.body} json truncated={detail.request.bodyTruncated} />
            </div>
          </TrafficDisclosure>
        </CardContent>
      </Card>

      <Card size="sm" aria-label="诊断信息">
        <CardHeader><CardTitle>诊断信息</CardTitle><CardDescription>记录定位、模型声明与原始事件，按需展开。</CardDescription></CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <TrafficDisclosure title="记录信息">
            <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-2">
              {[["提供商", provider], ["批次", session], ["调用编号", `#${detail.id}`], ["线程", detail.threadId], ["轮次", detail.turnId], ["请求类型", detail.requestKind], ["传输", requestLabel(detail)]].map(([label, value]) => (
                <div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="break-all">{value ?? "—"}</dd></div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" disabled={copyState === "pending"} onClick={() => void copyReference()}><CopyIcon data-icon="inline-start" />复制定位信息</Button>
              <span role="status" className="text-xs text-muted-foreground">{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败，请手动选择记录信息。" : ""}</span>
            </div>
          </TrafficDisclosure>
          {detail.response?.state === "completed" && hasResponseDiagnostics(detail.response) ? <TrafficDisclosure title="完成后的诊断信息">
            <p className="text-sm text-muted-foreground">已记录完成终态；以下信息不改变本次请求的完成状态。</p>
            <ResponseErrorDetails response={detail.response} />
          </TrafficDisclosure> : null}
          {detail.chatDiagnostics ? <TrafficDisclosure title="Chat 上游信息">
            <p className="text-sm">实际上游：{String(detail.chatDiagnostics.fields["routing.finalProvider"] ?? "未提供")} · 上游模型：{String(detail.chatDiagnostics.fields.model ?? "未提供")}</p>
            <p className="text-xs text-muted-foreground">上游回报的路由、标识和费用；不同费用字段保持各自口径，不代表套餐实际扣费。备用提供商不代表已调用。</p>
            <TrafficContent title="上游诊断字段" text={JSON.stringify(detail.chatDiagnostics.fields, null, 2)} json />
            {detail.chatDiagnostics.truncated ? <p className="text-xs text-muted-foreground">部分诊断字段超出限制或格式无效，未保留。</p> : null}
          </TrafficDisclosure> : null}

          <TrafficDisclosure title="模型声明与来源"><ModelEvidence detail={detail} /></TrafficDisclosure>
          <TrafficParameterComparison rows={detail.parameterComparison} />
          {detail.tracePage.total === 0 ? null : (
            <TrafficDisclosure title={`原始事件（${detail.tracePage.total} 条）`}>
              <div className="flex min-w-0 flex-col gap-3" aria-busy={traceLoading}>
                {traceLoading ? <><p role="status">正在加载原始事件…</p><Skeleton className="h-32 w-full" /></> : traceError ? <><p>原始事件加载失败，请重试。</p><Button type="button" variant="outline" onClick={onRetry}>重试原始事件</Button></> : <><p className="text-xs text-muted-foreground">当前 {detail.tracePage.offset + 1}–{detail.tracePage.offset + detail.trace.length} / {detail.tracePage.total} 条</p>{detail.trace.map((item, index) => (
                  <section key={`${item.atMs}-${item.kind}-${index}`} className="flex min-w-0 flex-col gap-1">
                    <p className="font-mono text-xs text-muted-foreground">
                      {formatTime(item.atMs)} [{item.kind}]{item.truncated ? "（已截断）" : ""}
                    </p>
                    <TrafficContent title="事件正文" text={item.text} json truncated={item.truncated} />
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
                      <ChevronLeftIcon data-icon="inline-start" />上一页
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
                      下一页<ChevronRightIcon data-icon="inline-end" />
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
  const label = state === "completed" ? "完成" : state === "failed" ? "失败"
    : state === "incomplete" ? "不完整" : "未记录终态"
  return <Badge variant={state === "completed" ? "secondary" : state === "pending" ? "outline" : "destructive"}>{label}</Badge>
}

function CallSummary({ detail }: { detail: TrafficExchangeDetail }) {
  const usage = detail.response?.usage
  const isModel = detail.category !== "models" && detail.category !== "prewarm"
  const rate = usage?.inputTokens !== undefined && usage.inputTokens > 0 && usage.cachedTokens !== undefined
    ? `${(usage.cachedTokens / usage.inputTokens * 100).toFixed(1)}%` : "—"
  const elapsed = (value: number | undefined) => value === undefined ? "—" : formatElapsedDuration(value)
  return <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
    {isModel ? <SummaryMetric label={<TableHint hint="提交发送至收到首段非空内容，含思考、正文或工具参数；缺失不补算。">首 Token</TableHint>} value={elapsed(detail.response?.firstTokenMs)} /> : null}
    <SummaryMetric label={<TableHint hint="提交发送至请求结束；不含发送前准备和客户端显示。">请求耗时</TableHint>} value={elapsed(detail.response?.callTiming?.totalMs)} />
    {isModel ? <>
      <SummaryMetric label="输入 Token" value={usage?.inputTokens?.toLocaleString() ?? "—"} description={usage?.cachedTokens === undefined ? undefined : `缓存 ${usage.cachedTokens.toLocaleString()} · ${rate}`} />
      <SummaryMetric label="输出 Token" value={usage?.outputTokens?.toLocaleString() ?? "—"} description={usage?.reasoningTokens === undefined ? undefined : `其中推理 ${usage.reasoningTokens.toLocaleString()}`} />
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

function ResponseFailure({ response }: { response: NonNullable<TrafficExchangeDetail["response"]> }) {
  if (response.state === "completed") return null
  return <Alert variant="destructive">
    <AlertTitle>{response.state === "incomplete" ? "响应不完整" : "请求失败"}</AlertTitle>
    <AlertDescription className="min-w-0">
      {response.failureStage === undefined ? null : <p>失败阶段：{response.failureStage}</p>}
      {response.failure === undefined && response.error === undefined && response.errorScope === undefined
        ? <p>记录未提供具体原因。</p>
        : <TrafficDisclosure title="错误详情"><ResponseErrorDetails response={response} /></TrafficDisclosure>}
    </AlertDescription>
  </Alert>
}

function hasResponseDiagnostics(response: NonNullable<TrafficExchangeDetail["response"]>) {
  return response.failureStage !== undefined || response.failure !== undefined || response.errorScope !== undefined || response.error !== undefined
}

function ResponseErrorDetails({ response }: { response: NonNullable<TrafficExchangeDetail["response"]> }) {
  return <TrafficContent title="原始诊断" text={JSON.stringify({ stage: response.failureStage, reason: response.failure, scope: response.errorScope, error: response.error }, null, 2)} json />
}

function outputLabel(item: NonNullable<TrafficExchangeDetail["response"]>["output"][number]): string {
  if (item.type === "message") return item.phase === "commentary" ? "过程说明" : "回答"
  if (item.type === "reasoning") return "推理摘要"
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    return `工具调用：${item.name ?? "未提供名称"}${item.callId === undefined ? "" : ` · ${item.callId}`}`
  }
  return item.type
}

function requestLabel(detail: TrafficExchangeDetail): string {
  if (detail.transport === "websocket") return `WebSocket ${detail.request.url ?? detail.url ?? ""}`
  return `${detail.request.method ?? "HTTP"} ${detail.request.path ?? ""}`.trim()
}

function HeaderTable({ title, headers }: { title: string; headers: Record<string, TrafficHeaderValue> }) {
  const entries = Object.entries(headers)
  if (entries.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <p className="break-all text-xs font-medium">{title}</p>
      <div className="rounded-md border bg-muted/50 p-3 font-mono text-xs">
        {entries.map(([name, value]) => (
          <p key={name} className="break-all">{name}: {Array.isArray(value) ? value.join(", ") : value}</p>
        ))}
      </div>
    </section>
  )
}

function ModelEvidence({ detail }: { detail: TrafficExchangeDetail }) {
  return <section className="flex min-w-0 flex-col gap-3 text-sm">
      <p className="text-muted-foreground">仅比较请求与响应回显名称，不验证模型身份。缺失不代表上游未发送。</p>
      <p className="break-all">请求模型：{detail.requestModel ?? "未提供"}</p>
      <p className="break-all">响应回显：{detail.responseModels.join("、") || "未提供"}</p>
      <p>服务端模型声明（不覆盖响应回显）：</p>
      {detail.modelEvidence.serverModels.length === 0 ? <p>未记录</p> : detail.modelEvidence.serverModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{entry.model} · 来源：{entry.source}</p>)}
      <p>安全缓冲候选声明（不表示已经切换，也不表示由该模型执行安全检查）：</p>
      {detail.modelEvidence.safetyModels.length === 0 ? <p>未记录</p> : detail.modelEvidence.safetyModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{entry.model} · 来源：{entry.source}</p>)}
      <p>X-Codex-Turn-State 字符数：</p>
      {detail.modelEvidence.turnStateLengths.length === 0 ? <p>未记录</p> : detail.modelEvidence.turnStateLengths.map((entry) => <p className="break-all" key={`${entry.source}:${entry.characters}`}>{entry.characters.toLocaleString("zh-CN")} 字符 · 来源：{entry.source}</p>)}
      {detail.modelEvidence.truncated ? <p>声明展示不完整：超过条数或字段长度限制，或含无效字符。</p> : null}
  </section>
}
