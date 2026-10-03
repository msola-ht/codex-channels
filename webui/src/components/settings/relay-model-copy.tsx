import { useState } from "react"
import { CopyIcon } from "lucide-react"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem } from "@/components/ui/dropdown-menu"

export function RelayModelCopy({ models }: { models: string[] }) {
  const { t } = useTranslation()
  const [feedback, setFeedback] = useState<{ model: string; state: "copied" | "failed" } | null>(null)
  const [pending, setPending] = useState(false)
  const copy = async (model: string) => {
    setPending(true)
    try {
      await navigator.clipboard.writeText(model)
      setFeedback({ model, state: "copied" })
    } catch { setFeedback({ model, state: "failed" }) }
    finally { setPending(false) }
  }
  return <div className="flex flex-col items-start gap-1">
    <DropdownMenu onOpenChange={open => { if (open) setFeedback(null) }}>
      <DropdownMenuTrigger render={<Button size="xs" variant="ghost" disabled={pending || !models.length} />}><CopyIcon data-icon="inline-start" />{t("relay.copyModelId")}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
        <DropdownMenuGroup>{models.map(model => <DropdownMenuItem key={model} disabled={pending} onClick={() => void copy(model)}>
          <CopyIcon /><span className="break-all">{model}</span>
        </DropdownMenuItem>)}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
    <span role="status" className="max-w-64 whitespace-normal text-xs text-muted-foreground">{feedback && t(feedback.state === "copied" ? "relay.modelCopied" : "relay.modelCopyFailed", { model: feedback.model })}</span>
    {feedback?.state === "failed" && <Input aria-label={t("relay.copyModelId")} value={feedback.model} readOnly onFocus={event => event.target.select()} />}
  </div>
}
