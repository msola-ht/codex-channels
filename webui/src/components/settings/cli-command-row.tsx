import { CheckIcon, CopyIcon } from "lucide-react"

import { Button } from "@/components/ui/button"

export function CliCommandRow({ entry, copied, onCopy }: {
  entry: { label: string; command: string; detail: string }
  copied: boolean
  onCopy: () => void
}) {
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-medium">{entry.label}</span>
      <span className="text-xs text-muted-foreground">{entry.detail} · 请在服务器终端执行</span>
    </div>
    <div className="flex items-center gap-2">
      <code className="rounded bg-muted px-2 py-1 text-xs">{entry.command}</code>
      <Button type="button" variant="outline" size="sm" onClick={onCopy} aria-label={`复制命令：${entry.command}`}>
        {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
        {copied ? "已复制" : "复制"}
      </Button>
    </div>
  </div>
}
