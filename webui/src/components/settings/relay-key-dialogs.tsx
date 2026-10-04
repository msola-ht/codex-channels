import { useRef } from "react"
import { RelayKeyModels } from "@/components/settings/relay-key-models"
import { useTranslation } from "@/hooks/use-translation"
import type { useRelayKeyEditor } from "@/hooks/use-relay-key-editor"
import type { useRelayManagement } from "@/hooks/use-relay-management"
import { translateApiError } from "@/lib/i18n/translate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Spinner } from "@/components/ui/spinner"
import { ErrorBanner } from "@/components/metrics/error-banner"

export function RelayKeyDialogs({ editor, management, blocked, refreshBlocked, onRefresh, restoreFocus }: {
  editor: ReturnType<typeof useRelayKeyEditor>
  management: ReturnType<typeof useRelayManagement>
  blocked: boolean
  refreshBlocked: boolean
  onRefresh: () => void
  restoreFocus: () => HTMLElement | false | null
}) {
  const { t } = useTranslation()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const data = management.data
  const {
    editing, setEditing, name, setName, caller, models, setModels, reasoning, changeReasoning,
    removedModelCount, result, setResult, nameInvalid, draftStale, latestCaller,
    modelsChanged, selectedModelsAvailable, selectedModelsSupportOff, openEditor, submit,
    confirm, preview, previewCaller,
  } = editor
  return <>
    <Dialog open={editing !== null && !preview} disablePointerDismissal onOpenChange={(open, details) => { if (management.busy) { details.cancel(); return }; if (!open) setEditing(null) }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl" closeLabel={t("relay.close")} finalFocus={restoreFocus} showCloseButton={!management.busy}><DialogHeader className="pr-8"><DialogTitle>{t(editing === "new" ? "relay.create" : "relay.edit")}</DialogTitle><DialogDescription>{t("relay.formHint")}</DialogDescription></DialogHeader>
        <FieldGroup className="min-h-0 overflow-y-auto px-1 py-1">
          <ErrorBanner error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />
          <ErrorBanner error={management.actionError ? translateApiError(t, management.actionError, management.actionErrorCode) : null} />
          {(management.error || management.actionError) && <Button variant="outline" disabled={refreshBlocked} onClick={onRefresh}>{t("relay.refresh")}</Button>}
          {draftStale && !management.loading && !management.error && <Alert><AlertDescription>{t(editing !== "new" && !latestCaller ? "relay.callerRemoved" : "relay.draftStale")}</AlertDescription></Alert>}
          {draftStale && (editing === "new" || latestCaller) && <Button variant="outline" disabled={blocked} onClick={() => { if (editing === "new") openEditor("new"); else if (latestCaller) openEditor(latestCaller) }}>{t("relay.reloadDraft")}</Button>}
          <Field data-invalid={name.length > 0 && nameInvalid} data-disabled={management.busy}><FieldLabel htmlFor="relay-name">{t("relay.purpose")}</FieldLabel>{editing === "new" && <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[name]} disabled={management.busy} aria-label={t("relay.purposePresetsLabel")} onValueChange={([value]) => { if (value) setName(value) }}>
            {(["translation", "coding", "chat", "writing", "testing"] as const).map(preset => <ToggleGroupItem key={preset} value={t(`relay.purposePresets.${preset}`)}>{t(`relay.purposePresets.${preset}`)}</ToggleGroupItem>)}
          </ToggleGroup>}<Input id="relay-name" value={name} disabled={management.busy} onChange={event => setName(event.target.value)} aria-invalid={name.length > 0 && nameInvalid} aria-describedby={name.length > 0 && nameInvalid ? "relay-name-hint relay-name-error" : "relay-name-hint"} /><FieldDescription id="relay-name-hint">{t("relay.purposeHint")}</FieldDescription>{name.length > 0 && nameInvalid && <FieldError id="relay-name-error">{t("relay.nameInvalid")}</FieldError>}{editing !== "new" && <FieldDescription>{t("relay.callerId")}: {caller}</FieldDescription>}</Field>
          {removedModelCount > 0 && <Alert><AlertDescription>{t("relay.offModelsRemoved", { count: removedModelCount })}</AlertDescription></Alert>}
          <RelayKeyModels providers={data?.providers ?? []} models={models} reasoning={reasoning} disabled={management.busy || draftStale} onChange={setModels} />
          <Field data-disabled={management.busy}><FieldLabel id="relay-reasoning-label">{t("relay.reasoning")}</FieldLabel><ToggleGroup variant="outline" value={[reasoning]} disabled={management.busy || draftStale} aria-labelledby="relay-reasoning-label" aria-describedby="relay-reasoning-hint" onValueChange={([value]) => { if (value === "passthrough" || value === "off") changeReasoning(value) }}><ToggleGroupItem value="passthrough">{t("relay.passthrough")}</ToggleGroupItem><ToggleGroupItem value="off">{t("relay.keyOff")}</ToggleGroupItem></ToggleGroup><FieldDescription id="relay-reasoning-hint">{t("relay.offHint")}</FieldDescription></Field>
        </FieldGroup>
        <DialogFooter><Button variant="outline" disabled={management.busy} onClick={() => setEditing(null)}>{t("relay.cancel")}</Button><Button disabled={blocked || draftStale || nameInvalid || !models.length || !selectedModelsSupportOff || modelsChanged && !selectedModelsAvailable} onClick={submit}>{management.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={preview !== undefined} onOpenChange={(open, details) => { if (management.busy) { details.cancel(); return }; if (!open) management.cancel() }}>
      <AlertDialogContent initialFocus={cancelRef} className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg" finalFocus={restoreFocus}>
        <AlertDialogHeader><AlertDialogTitle>{preview ? t(`relay.operation.${preview.command}`) : t("relay.confirm")}</AlertDialogTitle><AlertDialogDescription>{preview ? t(`relay.confirmHints.${preview.command}`) : ""}</AlertDialogDescription></AlertDialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {preview && <dl className="grid min-w-0 gap-3"><div><dt className="text-muted-foreground">{t("relay.purpose")}</dt><dd className="break-words">{previewCaller?.display_name ?? preview.caller}</dd></div><div><dt className="text-muted-foreground">{t("relay.callerId")}</dt><dd className="break-all">{preview.caller}</dd></div>{previewCaller && <><div><dt className="text-muted-foreground">{t("relay.provider")}</dt><dd className="break-all">{[...new Set(previewCaller.models.map(id => id.slice(0, id.indexOf("/"))))].join(", ")}</dd></div>{preview.command !== "delete" && <div><dt className="text-muted-foreground">{t("relay.models")}</dt><dd className="break-all">{previewCaller.models.join(", ")}</dd></div>}<div><dt className="text-muted-foreground">{t("relay.reasoning")}</dt><dd>{t(previewCaller.reasoning === "off" ? "relay.keyOff" : "relay.passthrough")}</dd></div></>}</dl>}
        </div>
        <AlertDialogFooter><AlertDialogCancel ref={cancelRef} disabled={management.busy}>{t("relay.cancel")}</AlertDialogCancel><AlertDialogAction variant={(preview?.command === "disable" || preview?.command === "delete") ? "destructive" : "default"} disabled={management.busy} onClick={event => { event.preventDefault(); void confirm() }}>{management.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.confirm")}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={result !== null} disablePointerDismissal onOpenChange={(open, details) => { if (management.busy) { details.cancel(); return }; if (!open) setResult(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl" closeLabel={t("relay.close")} finalFocus={restoreFocus} showCloseButton={!management.busy}><DialogHeader className="pr-8"><DialogTitle>{t("relay.saved")}</DialogTitle><DialogDescription>{result ? t(`relay.${result.activation}`) : ""}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      {result?.key && <Field><FieldLabel htmlFor="relay-secret">{t("relay.secret")}</FieldLabel><Input id="relay-secret" readOnly value={result.key} onFocus={event => event.target.select()} /><FieldDescription>{t("relay.secretHint")}</FieldDescription></Field>}
      {result?.cleanupStatus === "failed" && <Alert><AlertDescription>{t("relay.cleanupFailed")}</AlertDescription></Alert>}
      {result?.auditStatus === "failed" && <Alert><AlertDescription>{t("relay.auditFailed")}</AlertDescription></Alert>}
      </div>
      <DialogFooter><Button onClick={() => setResult(null)}>{t("relay.close")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>
}
