import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

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
import { formatBytes, formatTime } from "@/lib/format"
import type { TrafficExchangeDetail, TrafficHeaderValue } from "@/lib/types"

export function TrafficDetail({
  detail,
  onTracePageChange,
}: {
  detail: TrafficExchangeDetail
  onTracePageChange: (offset: number) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="font-semibold">#{detail.id}</span>
        <span className="text-muted-foreground">{formatTime(detail.startedAtMs)}</span>
        <StateBadge state={detail.state} />
        <span>
          模型：<span className="font-mono">{detail.requestModel ?? "未提供"}</span> →{" "}
          <span className="font-mono">{detail.responseModels.join("、") || "未提供"}</span>
        </span>
        <span className="text-muted-foreground">
          线程 {detail.threadId ?? "未提供"} · 轮次 {detail.turnId ?? "未提供"}
          {detail.account === undefined ? "" : ` · 账户 ${detail.account}`}
        </span>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>请求</CardTitle>
          <CardDescription>
            {requestLabel(detail)}
            {detail.request.bytes === undefined ? "" : ` · ${formatBytes(detail.request.bytes)}`}
            {detail.request.bodyTruncated ? " · 展示已截断" : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <HeaderTable title="请求头" headers={detail.request.headers} />
          <PayloadBlock title="请求正文" text={prettyJson(detail.request.body)} />
        </CardContent>
      </Card>

      {detail.response === null ? (
        <Alert>
          <AlertTitle>等待终态响应</AlertTitle>
          <AlertDescription>请求已记录，但尚未收到完成、失败或不完整终态。</AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              响应
              <StateBadge state={detail.response.state} />
            </CardTitle>
            <CardDescription>
              {detail.response.status === null ? "" : `HTTP ${detail.response.status}`}
              {detail.response.eventType === undefined ? "" : ` · ${detail.response.eventType}`}
              {detail.response.bytes === undefined ? "" : ` · 原始 ${formatBytes(detail.response.bytes)}`}
              {detail.response.durationMs === undefined ? "" : ` · ${detail.response.durationMs} ms`}
              {detail.response.bodyTruncated ? " · 展示已截断" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <HeaderTable title="响应头" headers={detail.response.headers} />
            <PayloadBlock title="终态响应" text={prettyJson(detail.response.body)} />
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
        <details className="rounded-lg border bg-card text-card-foreground shadow-sm">
          <summary className="cursor-pointer px-6 py-4 text-sm font-medium">
            原始传输轨迹（{detail.tracePage.total} 条，默认收起）
          </summary>
          <div className="flex flex-col gap-3 border-t px-6 py-4">
            {detail.trace.map((item, index) => (
              <section key={`${item.atMs}-${item.kind}-${index}`} className="flex flex-col gap-1">
                <p className="font-mono text-xs text-muted-foreground">
                  {formatTime(item.atMs)} [{item.kind}]{item.truncated ? "（已截断）" : ""}
                </p>
                <pre className="max-h-72 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
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

function requestLabel(detail: TrafficExchangeDetail): string {
  if (detail.transport === "websocket") return `WebSocket ${detail.request.url ?? detail.url ?? ""}`
  return `${detail.request.method ?? "HTTP"} ${detail.request.path ?? ""}`.trim()
}

function HeaderTable({ title, headers }: { title: string; headers: Record<string, TrafficHeaderValue> }) {
  const entries = Object.entries(headers)
  if (entries.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <p className="text-xs font-medium">{title}</p>
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
    <section className="flex flex-col gap-1">
      <p className="text-xs font-medium">{title}</p>
      <pre className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
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
