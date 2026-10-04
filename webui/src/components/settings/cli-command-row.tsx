import { CheckIcon, CopyIcon } from "lucide-react"
import { useTranslation } from "@/hooks/use-translation"

import { Button } from "@/components/ui/button"

export function CliCommandRow({ entry, copied, onCopy }: {
  entry: { label: string; command: string; detail: string }
  copied: boolean
  onCopy: () => void
}) {
  const { t } = useTranslation()
  return <div className="flex flex-wrap items-center justify-between gap-3">
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-medium">{entry.label}</span>
      <span className="text-xs text-muted-foreground">{t("managementUi.cliExecution", { detail: entry.detail })}</span>
    </div>
    <div className="flex items-center gap-2">
      <code className="rounded bg-muted px-2 py-1 text-xs">{entry.command}</code>
      <Button type="button" variant="outline" size="sm" onClick={onCopy} aria-label={t("managementUi.copyCommand", { command: entry.command })}>
        {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
        {t(copied ? "managementUi.copied" : "managementUi.copy")}
      </Button>
    </div>
  </div>
}
