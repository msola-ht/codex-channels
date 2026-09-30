import { Fragment, useState } from "react"
import type { UseApiState } from "@/hooks/use-api"
import { useTranslation } from "@/hooks/use-translation"
import type { SettingsSummaryResponse } from "@/lib/types"
import { CliCommandRow } from "@/components/settings/cli-command-row"
import { SettingsError, LoadingSettingsCard } from "@/components/settings/settings-feedback"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Alert, AlertDescription } from "@/components/ui/alert"

const commandIds = {
  general: ["gateway-config"], providers: ["codex-setup"], channels: ["channels"],
  data: ["metrics-storage"], services: ["service-status", "service-webui", "service-restart"],
} as const

export function SettingsCliCommands({ scope, summary }: { scope: keyof typeof commandIds; summary: UseApiState<SettingsSummaryResponse> & { refetch: () => void } }) {
  const { t } = useTranslation()
  if (summary.error) return <SettingsError message={summary.error} retry={summary.refetch} />
  if (!summary.data) return <LoadingSettingsCard title={t("navigation.cli")} />
  return <SettingsCliCommandList scope={scope} entries={summary.data.cli} />
}

export function SettingsCliCommandList({ scope, entries: allEntries }: { scope: keyof typeof commandIds; entries: SettingsSummaryResponse["cli"] }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const copy = async (id: string, command: string) => {
    try { await navigator.clipboard.writeText(command); setCopied(id); setFailed(false) }
    catch { setCopied(null); setFailed(true) }
  }
  const ids: readonly string[] = commandIds[scope]
  const entries = allEntries.filter(entry => ids.includes(entry.id))
  if (entries.length === 0) return null
  return <Card><CardHeader><CardTitle>{t("navigation.cli")}</CardTitle><CardDescription>{t("navigation.cliHint")}</CardDescription></CardHeader><CardContent className="flex flex-col gap-3">
    {entries.map((entry, index) => <Fragment key={entry.id}>{index > 0 && <Separator />}<CliCommandRow entry={entry} copied={copied === entry.id} onCopy={() => void copy(entry.id, entry.command)} /></Fragment>)}
    {failed && <Alert variant="destructive"><AlertDescription>{t("navigation.copyFailed")}</AlertDescription></Alert>}
  </CardContent></Card>
}
