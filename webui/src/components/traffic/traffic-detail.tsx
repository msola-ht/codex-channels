import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { formatBytes, formatTime } from "@/lib/format"
import type { TrafficExchangeDetail, TrafficHeaderValue } from "@/lib/types"

export function TrafficDetail({ detail }: { detail: TrafficExchangeDetail }) {
  const requestBody = prettyJson(detail.request?.body ?? "")
  const responseBody = prettyJson(detail.response?.body ?? "")
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <span className="font-semibold">#{detail.id}</span>
        <span className="text-muted-foreground">{formatTime(detail.startedAtMs)}</span>
        <span>
          模型：请求 <span className="font-mono">{detail.requestModel ?? "未提供"}</span> 响应{" "}
          <span className="font-mono">{detail.responseModels.join("、") || "未提供"}</span>
        </span>
        <span className="text-muted-foreground">
          线程 {detail.threadId ?? "未提供"} · 轮次 {detail.turnId ?? "未提供"} · 类型{" "}
          {detail.requestKind ?? "未提供"}
        </span>
      </div>

      {detail.request === null && detail.transport === "websocket" ? (
        <Card>
          <CardHeader>
            <CardTitle>WebSocket 连接</CardTitle>
            <CardDescription>{detail.url}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <HeaderTable title="握手请求头" headers={detail.websocketHeaders ?? {}} />
            {detail.frames.map((frame, index) => (
              <section key={`${frame.direction}-${index}`} className="flex flex-col gap-1">
                <p className="text-xs font-medium">
                  {frame.direction === "client" ? "→ App Server 发出" : "← 上游返回"}
                  {frame.truncated ? "（已截断）" : ""}
                </p>
                <pre className="max-h-72 overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs whitespace-pre-wrap break-all">
                  {prettyJson(frame.text)}
                </pre>
              </section>
            ))}
          </CardContent>
        </Card>
      ) : detail.request === null ? (
        <Alert>
          <AlertTitle>请求头缺失</AlertTitle>
          <AlertDescription>
            转储里没有这次交换的请求头记录，通常是被文件轮转清除了
          </AlertDescription>
        </Alert>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              请求 {detail.request.method} {detail.request.path}
            </CardTitle>
            <CardDescription>
              {detail.request.bytes === undefined ? "" : `原始 ${formatBytes(detail.request.bytes)}`}
              {detail.request.bodyTruncated ? " · 正文已在服务端截断" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <HeaderTable title="请求头" headers={detail.request.headers} />
            <PayloadBlock title="请求体" text={requestBody} />
          </CardContent>
        </Card>
      )}

      {detail.response === null ? null : (
        <Card>
          <CardHeader>
            <CardTitle>响应 {detail.response.status ?? "—"}</CardTitle>
            <CardDescription>
              {detail.response.bytes === undefined ? "" : `原始 ${formatBytes(detail.response.bytes)}`}
              {detail.response.durationMs === undefined ? "" : ` · 用时 ${detail.response.durationMs} ms`}
              {detail.response.bodyTruncated ? " · 正文已在服务端截断" : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <HeaderTable title="响应头" headers={detail.response.headers} />
            {detail.events.length === 0 ? (
              <PayloadBlock title="响应体" text={responseBody} />
            ) : (
              <section className="flex flex-col gap-2">
                <p className="text-xs font-medium">SSE 事件（{detail.events.length} 条）</p>
                <div className="max-h-96 overflow-auto rounded-md border bg-muted/50 p-3">
                  {detail.events.map((event, index) => (
                    <div key={`${event.type}-${index}`} className="mb-2 last:mb-0">
                      <p className="font-mono text-xs text-muted-foreground">[{event.type}]</p>
                      <pre className="font-mono text-xs whitespace-pre-wrap break-all">
                        {event.payload}
                      </pre>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </CardContent>
        </Card>
      )}

      {detail.closes.length === 0 && detail.errors.length === 0 ? null : (
        <Card>
          <CardHeader>
            <CardTitle>连接收尾</CardTitle>
            <CardDescription>中断只表示流没有正常收尾，不代表上游一定失败</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-xs">
            {detail.closes.map((close, index) => (
              <p key={`close-${index}`} className="font-mono">
                连接关闭：{close.peer} code={close.code}
                {close.reason === undefined ? "" : ` 原因=${close.reason}`}
              </p>
            ))}
            {detail.errors.map((error, index) => (
              <p key={`error-${index}`} className="font-mono text-destructive">
                中断：{error.scope}
                {error.message === undefined ? "" : ` ${error.message}`}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function HeaderTable({ title, headers }: { title: string; headers: Record<string, TrafficHeaderValue> }) {
  const entries = Object.entries(headers)
  if (entries.length === 0) return null
  return (
    <section className="flex flex-col gap-1">
      <p className="text-xs font-medium">{title}</p>
      <div className="rounded-md border bg-muted/50 p-3 font-mono text-xs">
        {entries.map(([name, value]) => (
          <p key={name} className="break-all">
            {name}: {Array.isArray(value) ? value.join(", ") : value}
          </p>
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
        {text}
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
