import { useRef, useState } from "react"
import { ChevronDownIcon, ChevronUpIcon, RefreshCwIcon } from "lucide-react"
import { useTranslation } from "@/hooks/use-translation"
import type { useBaseModelManagement } from "@/hooks/use-base-model-management"
import type { BaseModelPreview } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { SettingsError } from "@/components/settings/settings-feedback"
import { ManagementConfirmationDialog, SettingsRow, modelOperationDialogClassName } from "@/components/settings/settings-controls"

export function BaseModelCard({ management, disabled }: { management: ReturnType<typeof useBaseModelManagement>; disabled: boolean }) {
  const { t } = useTranslation()
  const previewTrigger = useRef<HTMLButtonElement>(null)
  const pending = management.pendingPreview?.preview
  const snapshot = !management.loading && !management.error ? management.data : null
  const result = management.actionResult
  const locked = disabled || management.busy || management.loading || management.error !== null || management.readbackRequired || pending !== undefined
  const warning = management.writeUnconfirmed || management.readbackRequired || result?.consistency === "unconfirmed" || result?.auditStatus === "degraded"
  return <Card>
    <CardHeader><CardTitle>{t("baseModel.title")}</CardTitle><CardDescription>{t("baseModel.hint")}</CardDescription></CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4">
      {management.loading && <Skeleton className="h-16 w-full" />}
      {management.error && <SettingsError message={management.error} retry={management.refetch} />}
      {snapshot && <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Badge variant="outline">{snapshot.model}</Badge>
        <Badge variant="secondary">{t("baseModel.version", { version: snapshot.cliVersion })}</Badge>
        <span className="text-sm text-muted-foreground">{t(snapshot.source === "bundled" ? "baseModel.bundled" : "baseModel.savedSource")}</span>
      </div>}
      <p className="text-sm text-muted-foreground">{t("baseModel.fetchHint")}</p>
      {management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
      {(result || management.writeUnconfirmed) && <Alert variant={warning ? "destructive" : "default"}><AlertDescription className="flex flex-col gap-2" aria-live="polite">
        <p>{t(management.writeUnconfirmed ? "baseModel.writeUnknown" : result?.consistency === "unconfirmed" ? "baseModel.readbackUnknown" : result?.status === "unchanged" ? "baseModel.unchanged" : "baseModel.updated")}</p>
        {result?.backupPath && <p>{t("baseModel.backup", { path: result.backupPath })}</p>}
        {result?.auditStatus === "degraded" && <p>{t("settingsUi.auditDegraded")}</p>}
        {management.readbackRequired && <p>{t("settingsUi.readbackUnknown")}</p>}
        <p>{t("baseModel.activation")}</p>
      </AlertDescription></Alert>}
    </CardContent>
    <CardFooter><Button ref={previewTrigger} variant="outline" disabled={locked || snapshot === null} onClick={() => { if (snapshot) void management.mutate({ revision: snapshot.revision }) }}>
      {management.busy && !pending ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : <RefreshCwIcon data-icon="inline-start" />}
      {t(management.busy && !pending ? "baseModel.fetching" : "baseModel.fetch")}
    </Button></CardFooter>
    <ManagementConfirmationDialog open={pending !== undefined} title={t("baseModel.confirmTitle")} description={t("baseModel.confirmHint")} className={modelOperationDialogClassName} finalFocus={previewTrigger} saving={management.busy} loading={management.loading} confirmDisabled={disabled || management.error !== null || management.readbackRequired} confirmLabel={t(pending?.changed ? "baseModel.save" : "baseModel.confirmUnchanged")} onConfirm={() => void management.confirm()} onCancel={management.cancel}>
      {pending && <div className="flex min-w-0 flex-col gap-4">
        <div className="grid min-w-0 gap-4 sm:grid-cols-2">{(["before", "after"] as const).map(side => <div key={side} className="flex min-w-0 flex-col gap-2">
          <p className="font-medium">{t(`baseModel.${side}`)}</p>
          <SettingsRow label={t("modelManagement.model")} value={pending[side].model} />
          <SettingsRow label={t("baseModel.cliVersion")} value={pending[side].cliVersion} />
          <code className="break-all text-xs">{pending[side].command}</code>
        </div>)}</div>
        <p>{t("baseModel.activation")}</p>
        <p>{t("baseModel.fetchHint")}</p>
        {!pending.changed && <p>{t("baseModel.unchanged")}</p>}
        {pending.changes.map(change => <section key={change.field} className="flex min-w-0 flex-col gap-3">
          <h3 className="font-medium break-all">{change.field}</h3>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">{(["before", "after"] as const).map(side => <div key={side} className="flex min-w-0 flex-col gap-2">
            <p className="text-muted-foreground">{t(`baseModel.${side}`)}</p>
            <BaseModelValue value={change[side]} />
          </div>)}</div>
        </section>)}
      </div>}
    </ManagementConfirmationDialog>
  </Card>
}

function BaseModelValue({ value }: { value: BaseModelPreview["changes"][number]["before"] }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const text = !value.present ? t("baseModel.absent") : typeof value.value === "string" ? value.value : JSON.stringify(value.value, null, 2)
  const long = (text?.length ?? 0) > 600 || (text?.split("\n").length ?? 0) > 8
  const content = <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{text === "" ? t("baseModel.empty") : text}</pre>
  if (!long) return content
  return <Collapsible open={expanded} onOpenChange={setExpanded} className="flex min-w-0 flex-col gap-2">
    {!expanded && <pre className="max-h-32 overflow-hidden whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{text?.slice(0, 400)}…</pre>}
    <CollapsibleTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
      {expanded ? <ChevronUpIcon data-icon="inline-start" /> : <ChevronDownIcon data-icon="inline-start" />}{t(expanded ? "baseModel.collapse" : "baseModel.expand")}
    </CollapsibleTrigger>
    <CollapsibleContent>{content}</CollapsibleContent>
  </Collapsible>
}
