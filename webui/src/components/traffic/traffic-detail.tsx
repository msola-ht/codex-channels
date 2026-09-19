import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { TrafficParameterComparison, TrafficRequestContent } from "@/components/traffic/traffic-request-content"

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
import { modelNameComparison } from "../../../../runtime/model-name-comparison.mjs"

export function TrafficDetail({
  detail,
  onTracePageChange,
}: {
  detail: TrafficExchangeDetail
  onTracePageChange: (offset: number) => void
}) {
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="font-semibold">#{detail.id}</span>
        <span className="text-muted-foreground">{formatTime(detail.startedAtMs)}</span>
        <span
          className="tabular-nums"
          title="来源：responsesapi.websocket_timing.timing_metrics.first_sampled_message_ttft_ms；仅使用与响应 ID 匹配的 logical_turn 统计，不代表客户端看到首字的时间。"
        >
          上游轮次首 Token：{detail.response?.timing?.firstTokenMs === undefined
            ? "未提供"
            : formatElapsedDuration(detail.response.timing.firstTokenMs)}
        </span>
        <StateBadge state={detail.state} />
        <Badge variant="outline">{detail.category === "models" ? "模型列表查询"
          : detail.category === "prewarm" ? "连接预热" : detail.requestKind ?? "模型请求"}</Badge>
        <span>
          模型：<span className="font-mono">{detail.requestModel ?? "未提供"}</span> →{" "}
          <span className="font-mono">{detail.responseModels.join("、") || "未提供"}</span>
        </span>
        <Badge variant="outline">{modelNameComparison(detail.requestModel, detail.responseModels.length === 1 ? detail.responseModels[0] : undefined)}</Badge>
        <span className="text-muted-foreground">
          线程 {detail.threadId ?? "未提供"} · 轮次 {detail.turnId ?? "未提供"}
          {detail.account === undefined ? "" : ` · 账户 ${detail.account}`}
        </span>
      </div>

      <Card className="min-w-0 shrink-0">
        <CardHeader>
          <CardTitle>模型声明与来源</CardTitle>
          <CardDescription>仅比较请求与响应回显名称，不验证模型身份。以下声明只来自本次调用保留的记录；缺失不代表上游未发送。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="break-all">请求模型（请求 model）：{detail.requestModel ?? "未提供"}</p>
          <p className="break-all">响应回显（响应索引）：{detail.responseModels.join("、") || "未提供"}</p>
          <div className="flex flex-col gap-1">
            <p>服务端模型声明（不覆盖响应回显）：</p>
            {detail.modelEvidence.serverModels.length === 0 ? <p className="text-muted-foreground">未记录</p>
              : detail.modelEvidence.serverModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{entry.model} · 来源：{entry.source}</p>)}
          </div>
          <div className="flex flex-col gap-1">
            <p>安全缓冲候选声明（不表示已经切换，也不表示由该模型执行安全检查）：</p>
            {detail.modelEvidence.safetyModels.length === 0 ? <p className="text-muted-foreground">未记录</p>
              : detail.modelEvidence.safetyModels.map((entry) => <p className="break-all" key={`${entry.source}:${entry.model}`}>{entry.model} · 来源：{entry.source}</p>)}
          </div>
          {detail.modelEvidence.truncated ? <p className="text-muted-foreground">声明展示不完整：超过条数或字段长度限制，或含无效字符。</p> : null}
        </CardContent>
      </Card>

      <Card className="min-w-0 shrink-0">
        <CardHeader>
          <CardTitle>请求</CardTitle>
          <CardDescription>
            {requestLabel(detail)}
            {detail.transport !== "http" || detail.request.bytes === undefined ? "" : ` · 原始 ${formatBytes(detail.request.bytes)}`}
            {detail.request.storedBytes === undefined ? "" : ` · 正文存储 ${formatBytes(detail.request.storedBytes)}`}
            {detail.request.bodyTruncated ? " · 展示已截断" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 text-sm">
            <span>思考等级：{detail.request.parameters.reasoningEffort ?? "未提供"}</span>
            <span>请求服务层级：{detail.request.parameters.serviceTier ?? "未提供"}</span>
            {detail.request.parameters.generate === false ? <Badge variant="outline">不生成输出</Badge> : null}
          </div>
          {detail.request.parameters.previousResponseId === undefined ? null : (
            <p className="break-all font-mono text-xs text-muted-foreground">接续响应：{detail.request.parameters.previousResponseId}</p>
          )}
          <TrafficRequestContent content={detail.request.content} />
          <TrafficParameterComparison rows={detail.parameterComparison} />
          <details>
            <summary className="cursor-pointer text-sm">请求头与原始正文{detail.request.bodyTruncated ? "（展示已截断）" : ""}</summary>
            <div className="flex flex-col gap-3 pt-3">
              <HeaderTable title="请求头" headers={detail.request.headers} />
              <PayloadBlock title="请求正文" text={prettyJson(detail.request.body)} />
            </div>
          </details>
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
            <p className="text-sm">实际服务层级：{detail.response.serviceTier ?? "未提供"}</p>
            {detail.response.failureStage === undefined ? null : (
              <Alert variant="destructive">
                <AlertTitle>失败阶段：{detail.response.failureStage}</AlertTitle>
                <AlertDescription>根据本次调用记录定位；不据此推断账户过期、代理故障或具体网络根因。</AlertDescription>
              </Alert>
            )}
            {detail.response.responseId === undefined ? null : (
              <p className="break-all font-mono text-xs text-muted-foreground">响应 ID：{detail.response.responseId}</p>
            )}
            <UsageSummary usage={detail.response.usage} />
            <TimingSummary response={detail.response} />
            {detail.response.output.map((item, index) => (
              <PayloadBlock key={index} title={outputLabel(item)} text={item.text || "（没有可展示的文本）"} />
            ))}
            {detail.response.output.length === 0 ? (
              <p className="text-sm text-muted-foreground">{detail.category === "prewarm" ? "连接预热，不生成回答。"
                : detail.category === "models" ? "模型列表查询，完整结果见原始正文。"
                  : "未提取到完成的输出条目，可展开原始正文与传输轨迹查看。"}</p>
            ) : null}
            {detail.response.outputTruncated ? (
              <Alert><AlertTitle>输出展示不完整</AlertTitle><AlertDescription>输出超出展示上限，或传输记录残缺、无法解析。原始调用记录未被修改。</AlertDescription></Alert>
            ) : null}
            {detail.response.failure === undefined ? null : <PayloadBlock title="终态错误 / 不完整原因" text={prettyJson(detail.response.failure)} />}
            <details>
              <summary className="cursor-pointer text-sm">响应头与原始终态（含逐条用量归因）{detail.response.bodyTruncated ? " · 展示已截断" : ""}</summary>
              <div className="flex flex-col gap-3 pt-3">
                <HeaderTable title="响应头" headers={detail.response.headers} />
                <PayloadBlock title="原始终态" text={prettyJson(detail.response.body)} />
              </div>
            </details>
            {detail.response.errorScope === undefined ? null : (
              <p className="font-mono text-xs text-destructive">
                {detail.response.errorScope}
                {detail.response.error === undefined ? "" : `：${detail.response.error}`}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {detail.tracePage.total === 0 ? null : (
        <details className="min-w-0 shrink-0 rounded-lg border bg-card text-card-foreground shadow-sm">
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            原始事件（{detail.tracePage.total} 条，默认收起）
          </summary>
          <div className="flex flex-col gap-3 border-t px-6 py-4">
            {detail.trace.map((item, index) => (
              <section key={`${item.atMs}-${item.kind}-${index}`} className="flex min-w-0 flex-col gap-1">
                <p className="font-mono text-xs text-muted-foreground">
                  {formatTime(item.atMs)} [{item.kind}]{item.truncated ? "（已截断）" : ""}
                </p>
                <pre className="max-w-full rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                  {prettyJson(item.text)}
                </pre>
              </section>
            ))}
            {detail.tracePage.previousOffset === null && detail.tracePage.nextOffset === null ? null : (
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={detail.tracePage.previousOffset === null}
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
                  disabled={detail.tracePage.nextOffset === null}
                  onClick={() => detail.tracePage.nextOffset === null
                    ? undefined
                    : onTracePageChange(detail.tracePage.nextOffset)}
                >
                  下一页<ChevronRightIcon data-icon="inline-end" />
                </Button>
              </div>
            )}
          </div>
        </details>
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
        顶部轮次首 Token 取自上游 first_sampled_message_ttft_ms；单请求首字从上游转发开始计时，HTTP 取跳过 created/in_progress 的首个 Responses 语义事件，WS 取 delta 或 output_text/function_call_arguments.done。不要求文本非空，不计纯错误、响应头或旁路元数据，均不代表客户端显示时间；历史值不从 trace 反推。
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

function PayloadBlock({ title, text }: { title: string; text: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <p className="break-all text-xs font-medium">{title}</p>
      <pre className="max-w-full rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
        {text || "（空）"}
      </pre>
    </section>
  )
}

function prettyJson(text: string): string {
  if (text.length === 0) return ""
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
