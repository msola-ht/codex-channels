import { useMemo, useState, type ReactNode } from "react"
import { CopyIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/** 收起时不挂载正文，避免隐藏内容仍占用渲染与格式化开销。 */
export function TrafficDisclosure({ title, children }: { title: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer break-all text-sm">{title}</summary>
    {open ? <div className="flex min-w-0 flex-col gap-3 pt-3">{children}</div> : null}
  </details>
}

export function TrafficContent({ title, text, json = false, truncated = false }: { title: string; text: string; json?: boolean; truncated?: boolean }) {
  const [wrap, setWrap] = useState(true)
  const [formatted, setFormatted] = useState(json && !truncated)
  const [copyState, setCopyState] = useState<"idle" | "pending" | "copied" | "failed">("idle")
  const shown = useMemo(() => {
    if (!formatted || truncated) return text
    try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
  }, [formatted, text, truncated])
  const copy = async () => {
    setCopyState("pending")
    try {
      await navigator.clipboard.writeText(text)
      setCopyState("copied")
    } catch { setCopyState("failed") }
  }
  return <section className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <p className="break-all text-xs font-medium">{title}</p>
      <Button type="button" size="sm" variant="outline" disabled={copyState === "pending"} onClick={() => void copy()}><CopyIcon data-icon="inline-start" />复制原文</Button>
      <Button type="button" size="sm" variant="outline" aria-pressed={wrap} onClick={() => setWrap(!wrap)}>自动换行</Button>
      {json && !truncated ? <Button type="button" size="sm" variant="outline" aria-pressed={formatted} onClick={() => setFormatted(!formatted)}>格式化</Button> : null}
      <span role="status" className="text-xs text-muted-foreground">{copyState === "copied" ? "已复制原文" : copyState === "failed" ? "复制失败，请手动选择正文复制。" : ""}</span>
    </div>
    {truncated ? <p className="text-xs text-muted-foreground">内容已截断，展示和复制均仅包含已保留片段。</p> : null}
    <pre className={cn("max-h-96 max-w-full overflow-auto rounded-md border bg-muted/50 p-3 font-mono text-xs", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>{shown || "（空）"}</pre>
  </section>
}
