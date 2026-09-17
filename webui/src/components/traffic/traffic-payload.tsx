import { useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { formatBytes } from "@/lib/format"

const chunkBytes = 64 * 1024

/**
 * 转储正文：JSON 对象按顶层字段折叠，只显示字段名与体积；展开后先渲染前 64 KiB，
 * 需要时逐段继续加载，避免把几 MB 文本一次性塞进 DOM。非 JSON 文本直接按段渲染。
 */
export function TrafficPayload({ text }: { text: string }) {
  const fields = useMemo(() => payloadFields(text), [text])
  if (fields === null) return <TextBlock text={text} />
  return (
    <div className="flex flex-col gap-2">
      {fields.map((field) => <FieldBlock key={field.name} field={field} />)}
    </div>
  )
}

interface PayloadField {
  name: string
  text: string
}

function FieldBlock({ field }: { field: PayloadField }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <section className="rounded-md border bg-muted/50">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="flex h-auto w-full items-center justify-between gap-3 rounded-md px-3 py-2"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="truncate font-mono text-xs">{field.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(byteSize(field.text))}</span>
      </Button>
      {expanded ? (
        <div className="border-t p-3">
          <TextBlock text={field.text} />
        </div>
      ) : null}
    </section>
  )
}

function TextBlock({ text }: { text: string }) {
  const [limit, setLimit] = useState(chunkBytes)
  const bytes = byteSize(text)
  const bounded = boundText(text, limit)
  return (
    <div className="flex flex-col gap-2">
      <pre className="max-h-96 overflow-auto font-mono text-xs whitespace-pre-wrap break-all">{bounded.text}</pre>
      {bounded.truncated ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setLimit(limit + chunkBytes)}
          >继续加载</Button>
          <span className="text-xs text-muted-foreground">
            已显示 {formatBytes(Math.min(limit, bytes))} / {formatBytes(bytes)}
          </span>
        </div>
      ) : null}
    </div>
  )
}

function payloadFields(text: string): PayloadField[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null
  return Object.entries(parsed).map(([name, value]) => ({
    name,
    text: JSON.stringify(value, null, 2) ?? String(value),
  }))
}

function boundText(text: string, limit: number): { text: string; truncated: boolean } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= limit) return { text, truncated: false }
  return { text: new TextDecoder().decode(bytes.subarray(0, limit)), truncated: true }
}

function byteSize(text: string): number {
  return new TextEncoder().encode(text).length
}
