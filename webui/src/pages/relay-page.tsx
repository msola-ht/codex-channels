import { useRef } from "react"
import { RelayProviderModels } from "@/components/settings/relay-provider-models"
import { RelayServiceManagement } from "@/components/settings/relay-service-management"
import { RelayKeyTable } from "@/components/settings/relay-key-table"
import { RelayKeyDialogs } from "@/components/settings/relay-key-dialogs"
import { useRelayServiceManagement } from "@/hooks/use-relay-service-management"
import { useRelayManagement } from "@/hooks/use-relay-management"
import { useRelayKeyEditor } from "@/hooks/use-relay-key-editor"
import { useTranslation } from "@/hooks/use-translation"
import type { RelayManagedCaller, RelayManagementInput } from "@/lib/types"
import { translateApiError } from "@/lib/i18n/translate"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ErrorBanner } from "@/components/metrics/error-banner"

export function RelayPage() {
  const { t } = useTranslation()
  const management = useRelayManagement()
  const data = management.data
  const snapshotCurrent = !management.loading && management.error === null
  const refreshingBlocked = management.busy || management.loading || management.pendingPreview !== null
  const serviceManagement = useRelayServiceManagement(management.refetch, refreshingBlocked)
  const blocked = refreshingBlocked || management.error !== null
  const editor = useRelayKeyEditor(management, blocked)
  const { editing, preview, result } = editor
  const returnFocus = useRef<HTMLElement | null>(null)
  const pageHeading = useRef<HTMLHeadingElement | null>(null)
  const openEditor = (value: "new" | RelayManagedCaller) => {
    if (editor.openEditor(value)) returnFocus.current = document.activeElement as HTMLElement
  }
  const restoreFocus = () => {
    if (editing === null && preview === undefined && result === null) {
      const target = returnFocus.current
      return target?.isConnected && !target.matches(":disabled") ? target : pageHeading.current
    }
    return false
  }
  const startAction = (input: RelayManagementInput) => {
    returnFocus.current = document.getElementById(`relay-actions-${input.caller}`)
    editor.mutate(input)
  }
  return <div className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h1 ref={pageHeading} tabIndex={-1} className="text-xl font-semibold">{t("relay.title")}</h1><p className="text-sm text-muted-foreground">{t("relay.description")}</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={serviceManagement.refreshBlocked} onClick={serviceManagement.refresh}>{t("relay.refresh")}</Button><Button disabled={blocked || !data} onClick={() => openEditor("new")}>{t("relay.create")}</Button></div>
    </div>
    <ErrorBanner error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />
    <ErrorBanner error={management.actionError ? translateApiError(t, management.actionError, management.actionErrorCode) : null} />
    <RelayServiceManagement controller={serviceManagement} snapshot={data} loading={management.loading} current={snapshotCurrent} />
    {data && <RelayProviderModels snapshot={data} blocked={blocked} refreshBlocked={refreshingBlocked} onRefresh={management.refetch} error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />}
    {management.loading && <div role="status" aria-label={t("common.loading")}><Skeleton className="h-24 w-full" /></div>}
    {data && !management.loading && !management.error && <RelayKeyTable snapshot={data} blocked={blocked} onEdit={openEditor} onAction={startAction} />}
    <RelayKeyDialogs editor={editor} management={management} blocked={blocked} refreshBlocked={serviceManagement.refreshBlocked} onRefresh={serviceManagement.refresh} restoreFocus={restoreFocus} />
  </div>
}
