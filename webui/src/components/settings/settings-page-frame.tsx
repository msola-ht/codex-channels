import { useEffect, useRef, type ReactNode } from "react"
import { useTranslation } from "@/hooks/use-translation"
import type { MessageKey } from "@/lib/i18n/messages"
import { Button } from "@/components/ui/button"
import { scheduleVisibleSettingsRefresh } from "@/lib/api-polling"

export function SettingsPageFrame({ title, busy, refresh, children }: { title: MessageKey; busy: boolean; refresh: () => void; children: ReactNode }) {
  const { t } = useTranslation()
  const refreshState = useRef({ pending: false, lastRefresh: Date.now() })
  useEffect(() => scheduleVisibleSettingsRefresh(refresh, busy, document, refreshState.current), [busy, refresh])
  const manualRefresh = () => {
    refreshState.current.pending = false
    refreshState.current.lastRefresh = Date.now()
    refresh()
  }
  return <div className="flex min-w-0 flex-col gap-6">
    <div className="flex items-center justify-between gap-3"><h1 className="text-xl font-semibold">{t(title)}</h1><Button variant="outline" disabled={busy} onClick={manualRefresh}>{t("relay.refresh")}</Button></div>
    {children}
  </div>
}
