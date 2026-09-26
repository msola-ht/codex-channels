import { useState } from "react"
import { ChevronLeftIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import { TrafficParameterComparison, TrafficRequestContent } from "@/components/traffic/traffic-request-content"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { TrafficContent, TrafficDisclosure } from "@/components/traffic/traffic-content"
import { TableHint } from "@/components/metrics/data-table"
import { FastBadge } from "@/components/metrics/service-tier"
import { Skeleton } from "@/components/ui/skeleton"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
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
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="break-all">提供商 {provider} · 批次 {session}</span>
        <TableHint hint="批次内编号，新批次重新计数；与提供商、批次一起定位唯一调用。"><span className="whitespace-nowrap">调用编号 #{detail.id}</span></TableHint>
        <Button type="button" variant="outline" size="sm" disabled={copyState === "pending"} onClick={() => void copyReference()}><CopyIcon data-icon="inline-start" />复制定位信息</Button>
        <span role="status">{copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败，请手动复制上方定位信息。" : ""}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="text-muted-foreground">{formatTime(detail.startedAtMs)}</span>
        <TableHint hint={detail.response?.firstContentMs === undefined ? null : "上游转发开始至首个符合条件的语义事件，不是响应头到达或客户端显示时间；与上游 logical_turn 统计分开。"}><span className="whitespace-nowrap tabular-nums">单请求首字：{detail.response?.firstContentMs === undefined ? "未提供" : formatElapsedDuration(detail.response.firstContentMs)}</span></TableHint>
        <span className="whitespace-nowrap tabular-nums">总耗时：{detail.response?.callTiming?.totalMs === undefined ? "未提供" : formatElapsedDuration(detail.response.callTiming.totalMs)}</span>
        <StateBadge state={detail.state} />
        <Badge variant="outline">{detail.category === "models" ? "模型列表查询"
          : detail.category === "prewarm" ? "连接预热" : detail.requestKind ?? "模型请求"}</Badge>
        <TrafficModel request={detail.requestModel} responses={detail.responseModels} upstream={detail.upstreamProvider} />
        <span className="min-w-0 break-all text-muted-foreground">
          线程 {detail.threadId ?? "未提供"} · 轮次 {detail.turnId ?? "未提供"}
          {detail.account === undefined ? "" : ` · 账户 ${detail.account}`}
        </span>
      </div>
      {traceLoading ? <p role="status" className="text-sm text-muted-foreground">正在刷新调用记录，当前摘要为上次成功读取的内容。</p> : null}
      {detail.response === null ? null : <UsageSummary usage={detail.response.usage} />}
      {detail.response?.failureStage === undefined ? null : (
        <Alert variant="destructive"><AlertTitle>失败阶段：{detail.response.failureStage}</AlertTitle><AlertDescription>根据本次调用记录定位；不据此推断账户过期、代理故障或具体网络根因。</AlertDescription></Alert>
      )}
      {detail.response?.failure === undefined ? null : <TrafficContent title="终态错误 / 不完整原因" text={detail.response.failure} json />}

      <Card className="min-w-0 shrink-0">
        <CardHeader>
          <CardTitle>请求</CardTitle>
          <CardDescription className="break-all">
            {requestLabel(detail)}
            {detail.transport !== "http" || detail.request.bytes === undefined ? "" : ` · 原始 ${formatBytes(detail.request.bytes)}`}
            {detail.request.storedBytes === undefined ? "" : ` · 正文存储 ${formatBytes(detail.request.storedBytes)}`}
            {detail.request.bodyTruncated ? " · 展示已截断" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 text-sm">
            <span>思考等级：{detail.request.parameters.reasoningEffort ?? "未提供"}</span>
            <span className="inline-flex items-center gap-2">请求服务层级：{detail.request.parameters.serviceTier ?? "未提供"}<FastBadge tier={detail.request.parameters.serviceTier} source="request" /></span>
            {detail.request.parameters.generate === false ? <Badge variant="outline">不生成输出</Badge> : null}
          </div>
          {detail.request.parameters.previousResponseId === undefined ? null : (
            <p className="break-all font-mono text-xs text-muted-foreground">接续响应：{detail.request.parameters.previousResponseId}</p>
          )}
          <TrafficRequestContent content={detail.request.content} />
          <TrafficDisclosure title={`请求头与原始正文${detail.request.bodyTruncated ? "（展示已截断）" : ""}`}>
            <div className="flex flex-col gap-3 pt-3">
              <HeaderTable title="请求头" headers={detail.request.headers} />
              <TrafficContent title="请求正文" text={detail.request.body} json truncated={detail.request.bodyTruncated} />
            </div>
          </TrafficDisclosure>
        </CardContent>
      </Card>

      {detail.response === null ? (
        <Alert>
          <AlertTitle>等待终态响应</AlertTitle>
          <AlertDescription>请求已记录，但尚未收到完成、失败或不完整终态。</AlertDescription>
        </Alert>
      ) : (
        <Card className="min-w-0 shrink-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              响应
              <StateBadge state={detail.response.state} />
            </CardTitle>
            <CardDescription>
              {detail.response.status === null ? "" : `HTTP ${detail.response.status}`}
              {detail.response.eventType === undefined ? "" : ` · ${detail.response.eventType}`}
              {detail.transport !== "http" || detail.response.bytes === undefined ? "" : ` · 传输 ${formatBytes(detail.response.bytes)}`}
              {detail.response.storedBytes === undefined ? "" : ` · 终态存储 ${formatBytes(detail.response.storedBytes)}`}
              {detail.response.bodyTruncated ? " · 展示已截断" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="flex items-center gap-2 text-sm">响应服务层级：{detail.response.serviceTier ?? "未提供"}<FastBadge tier={detail.response.serviceTier} source="response" /></p>
            {detail.response.responseId === undefined ? null : (
              <p className="break-all font-mono text-xs text-muted-foreground">响应 ID：{detail.response.responseId}</p>
            )}
            {detail.response.output.map((item, index) => (
              <TrafficContent key={index} title={outputLabel(item)} text={item.text} />
            ))}
            {detail.response.output.length === 0 ? (
              <p className="text-sm text-muted-foreground">{detail.category === "prewarm" ? "连接预热，不生成回答。"
                : detail.category === "models" ? "模型列表查询，完整结果见原始正文。"
                  : "未提取到完成的输出条目，可展开原始正文与传输轨迹查看。"}</p>
            ) : null}
            {detail.response.outputTruncated ? (
              <Alert><AlertTitle>输出展示不完整</AlertTitle><AlertDescription>输出超出展示上限，或传输记录残缺、无法解析。原始调用记录未被修改。</AlertDescription></Alert>
            ) : null}
            <TrafficDisclosure title={`响应头与原始终态（含逐条用量归因）${detail.response.bodyTruncated ? " · 展示已截断" : ""}`}>
              <div className="flex flex-col gap-3 pt-3">
                <HeaderTable title="响应头" headers={detail.response.headers} />
                <TrafficContent title="原始终态" text={detail.response.body} json truncated={detail.response.bodyTruncated} />
              </div>
            </TrafficDisclosure>
            {detail.response.errorScope === undefined ? null : (
              <p className="break-all font-mono text-xs text-destructive">
                {detail.response.errorScope}
                {detail.response.error === undefined ? "" : `：${detail.response.error}`}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {detail.chatDiagnostics ? <TrafficDisclosure title="Chat 上游信息">
        <p className="text-sm">实际上游：{String(detail.chatDiagnostics.fields["routing.finalProvider"] ?? "未提供")} · 上游模型：{String(detail.chatDiagnostics.fields.model ?? "未提供")}</p>
        <p className="text-xs text-muted-foreground">上游回报的路由、标识和费用；不同费用字段保持各自口径，不代表套餐实际扣费。备用提供商不代表已调用。</p>
        <TrafficContent title="上游诊断字段" text={JSON.stringify(detail.chatDiagnostics.fields, null, 2)} json />
        {detail.chatDiagnostics.truncated ? <p className="text-xs text-muted-foreground">部分诊断字段超出限制或格式无效，未保留。</p> : null}
      </TrafficDisclosure> : null}

      <TrafficDisclosure title="诊断信息：详细耗时、模型声明与参数对照">
        {detail.response === null ? null : <TimingSummary response={detail.response} />}
        <ModelEvidence detail={detail} />
        <TrafficParameterComparison rows={detail.parameterComparison} />
      </TrafficDisclosure>
      {detail.tracePage.total === 0 ? null : (
        <TrafficDisclosure title={`原始事件（${detail.tracePage.total} 条）`}>
          <div className="flex flex-col gap-3 border-t px-6 py-4" aria-busy={traceLoading}>
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
    </div>
  )
}

function StateBadge({ state }: { state: TrafficExchangeDetail["state"] }) {
  const label = state === "completed" ? "完成" : state === "failed" ? "失败"
    : state === "incomplete" ? "不完整" : "进行中"
  return <Badge variant={state === "completed" ? "secondary" : state === "pending" ? "outline" : "destructive"}>{label}</Badge>
}

function UsageSummary({ usage }: { usage: NonNullable<TrafficExchangeDetail["response"]>["usage"] }) {
  if (usage === null) return <p className="text-sm text-muted-foreground">上游未提供可解析的用量。</p>
  const rate = usage.inputTokens !== undefined && usage.inputTokens > 0 && usage.cachedTokens !== undefined
    ? `${(usage.cachedTokens / usage.inputTokens * 100).toFixed(1)}%` : "—"
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm tabular-nums">
      <span>输入 Token：{usage.inputTokens?.toLocaleString() ?? "—"}</span>
      <span>缓存：{usage.cachedTokens?.toLocaleString() ?? "—"}（{rate}）</span>
      <span>输出 Token：{usage.outputTokens?.toLocaleString() ?? "—"}</span>
      <span>其中推理：{usage.reasoningTokens?.toLocaleString() ?? "—"}</span>
    </div>
  )
}

function TimingSummary({ response }: { response: NonNullable<TrafficExchangeDetail["response"]> }) {
  const timing = response.timing
  const call = response.callTiming
  const metrics = [
    ["单请求首字耗时", response.firstContentMs],
    ["本次调用总耗时", call?.totalMs],
    ["转发前准备", call?.preForwardMs],
    ["转发至首字事件", call?.firstEventWaitMs],
    ["首字事件至结束", call?.afterFirstEventMs],
    ...(response.httpTiming === null ? [
      ["转发开始至提交发送", call?.submitWaitMs],
      ["提交发送至首字事件", call?.submittedToFirstEventMs],
    ] as const : [
      ["入口至收齐请求体", call?.receiveRequestMs],
      ["收齐请求体至响应头", call?.waitResponseHeadMs],
      ["响应头至结束", call?.receiveResponseMs],
    ] as const),
  ] as const
  const upstreamMetrics = [
    ["上游轮次首 Token", timing?.firstTokenMs],
    ["上游最大排队", timing?.queueMaxMs],
    ["上游轮次累计生成", timing?.samplingMs],
    ["上游 logical turn", timing?.totalMs],
    ["客户端工具暂停", timing?.toolPauseMs],
  ] as const
  return (
    <section className="flex flex-col gap-2" aria-label="耗时摘要">
      <p className="text-sm font-medium">本次调用</p>
      <dl className="grid grid-cols-2 gap-3 text-sm tabular-nums sm:grid-cols-3">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value === undefined ? "未提供" : formatElapsedDuration(value)}</dd>
          </div>
        ))}
      </dl>
      {call === null ? <p className="text-xs text-muted-foreground">未记录单调时钟阶段，不从历史记录补算。原始记录耗时（墙钟）：{response.durationMs === undefined ? "未提供" : formatElapsedDuration(response.durationMs)}。</p> : null}
      {call?.connectionReady === undefined ? null : <p className="text-xs text-muted-foreground">本次 WebSocket 请求进入转发时，连接{call.connectionReady ? "已就绪" : "尚未就绪"}；提交发送不表示上游已经收到。</p>}
      <p className="text-xs text-muted-foreground">本次调用阶段使用同一单调时钟。首字后仍包含生成、传输和背压暂停，不是纯生成耗时；HTTP 请求接收与上游转发可重叠，其他阶段不能重复相加。失败记录中的结束表示本地观察到中断。</p>
      <p className="text-sm font-medium">上游轮次统计（独立口径）</p>
      <dl className="grid grid-cols-2 gap-3 text-sm tabular-nums sm:grid-cols-3">
        {upstreamMetrics.map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd>{value === undefined ? "未提供" : formatElapsedDuration(value)}</dd></div>)}
      </dl>
      <p className="text-xs text-muted-foreground">
        {timing === null ? "未提取到与此响应匹配的上游 logical_turn 耗时。" : "上游统计范围：logical_turn。"}
        上游轮次首 Token 取自上游 first_sampled_message_ttft_ms；单请求首字从上游转发开始计时，HTTP 与 WS 共用内容帧口径，只认以 delta 或 done 结尾的内容事件，不计 lifecycle、条目与分片边界、终态、纯错误、响应头或旁路元数据。不要求事件已携带可见文本，均不代表客户端显示时间；历史值不从 trace 反推。
        各项口径不同且可能重叠，不能相加；不代表整轮对话耗时，差值也不等于网络延迟。
      </p>
    </section>
  )
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
  return <Card className="min-w-0 shrink-0">
    <CardHeader><CardTitle>模型声明与来源</CardTitle><CardDescription>仅比较请求与响应回显名称，不验证模型身份。缺失不代表上游未发送。</CardDescription></CardHeader>
    <CardContent className="flex flex-col gap-3 text-sm">
      <p className="break-all">请求模型：{detail.requestModel ?? "未提供"}</p>
      <p className="break-all">响应回显：{detail.responseModels.join("、") || "未提供"}</p>
      <p>服务端模型声明（不覆盖响应回显）：</p>
      {detail.modelEvidence.serverModels.length === 0 ? <p>未记录</p> : detail.modelEvidence.serverModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{entry.model} · 来源：{entry.source}</p>)}
      <p>安全缓冲候选声明（不表示已经切换，也不表示由该模型执行安全检查）：</p>
      {detail.modelEvidence.safetyModels.length === 0 ? <p>未记录</p> : detail.modelEvidence.safetyModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{entry.model} · 来源：{entry.source}</p>)}
      <p>X-Codex-Turn-State 字符数：</p>
      {detail.modelEvidence.turnStateLengths.length === 0 ? <p>未记录</p> : detail.modelEvidence.turnStateLengths.map((entry) => <p className="break-all" key={`${entry.source}:${entry.characters}`}>{entry.characters.toLocaleString("zh-CN")} 字符 · 来源：{entry.source}</p>)}
      {detail.modelEvidence.truncated ? <p>声明展示不完整：超过条数或字段长度限制，或含无效字符。</p> : null}
    </CardContent>
  </Card>
}
