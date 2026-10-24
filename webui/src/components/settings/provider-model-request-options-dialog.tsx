import { useEffect, useRef, useState, type ComponentProps } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import { ManagementConfirmationDialog, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { useTranslation } from "@/hooks/use-translation"
import { ApiClientError, fetchManagedProviderModelRequestOptions } from "@/lib/api"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import type { ProviderSettingsController } from "@/lib/settings-management"
import type { ManagementProviderSettingsPreview } from "@/lib/types"
import { validateClinePassProviderOptions } from "../../../../runtime/cline-provider-options.mjs"
import type { ManagedProviderModelRequestOptions } from "../../../../scripts/managed-provider-model-edit.mjs"

export interface ProviderModelRequestOptionsTarget {
  provider: string
  model: string
  displayName: string
  resourceRevision: string
}

type RequestOptionsPreview = Extract<ManagementProviderSettingsPreview, { operation: "model.request-options" }>
const requestOptionsPreset = { gateway: { only: ["deepseek"], has: ["vision", "implicit-caching"] } }
const requestOptionsPresetText = JSON.stringify(requestOptionsPreset, null, 2)

export function ProviderModelRequestOptionsDialog({ target, open, stale, management, finalFocus, onClose }: {
  target: ProviderModelRequestOptionsTarget
  open: boolean
  stale: boolean
  management: ProviderSettingsController
  finalFocus: ComponentProps<typeof DialogContent>["finalFocus"]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<{ loading: boolean; data: ManagedProviderModelRequestOptions | null; errorCode: string | null }>({ loading: true, data: null, errorCode: null })
  const [text, setText] = useState("{}")
  const loadedIdentity = useRef<string | null>(null)
  const busy = management.busy || management.loading || management.error !== null || management.readbackRequired
  const identity = `${target.provider}\0${target.model}\0${reload}`

  useEffect(() => {
    if (!open || stale || loadedIdentity.current === identity) return
    const controller = new AbortController()
    setState({ loading: true, data: null, errorCode: null })
    void fetchManagedProviderModelRequestOptions(target.provider, target.model, controller.signal).then(data => {
      if (controller.signal.aborted) return
      loadedIdentity.current = identity
      setState({ loading: false, data, errorCode: null })
      setText(JSON.stringify(data.providerOptions, null, 2))
    }, error => {
      if (controller.signal.aborted) return
      setState({ loading: false, data: null,
        errorCode: error instanceof ApiClientError ? error.code : "provider_models_unavailable" })
    })
    return () => controller.abort()
  }, [identity, open, stale, target.model, target.provider])

  const parsed = parseRequestOptions(text)
  const disabled = busy || stale || state.loading || state.data === null
  const profile = state.data?.requestProfile === "deepseek-flash" ? t("modelAddition.deepseekFlashProfile") : t("modelAddition.standardProfile")

  return <Dialog open={open} disablePointerDismissal onOpenChange={(next, details) => { if (busy) { details.cancel(); return }; if (!next && open) onClose() }}>
    <DialogContent finalFocus={open ? finalFocus : false} closeLabel={t("common.close")} showCloseButton={!management.busy} className={modelOperationDialogClassName}>
      <DialogHeader className="shrink-0"><DialogTitle>{t("clineRequestOptions.title")}</DialogTitle><DialogDescription>{t("clineRequestOptions.hint")}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <div className="flex flex-col gap-1"><code className="break-all">{target.provider} · {target.model}</code><p className="text-sm text-muted-foreground">{state.data ? `${target.displayName} · ${profile}` : target.displayName}</p></div>
        {stale ? <Alert variant="destructive"><AlertDescription>{t("modelCatalog.stale")}</AlertDescription></Alert> : null}
        {state.errorCode ? <Alert variant="destructive"><AlertDescription>{translateApiErrorCode(t, state.errorCode)} <Button variant="link" className="h-auto p-0" onClick={() => setReload(value => value + 1)}>{t("clineRequestOptions.reload")}</Button></AlertDescription></Alert> : null}
        {state.loading ? <p aria-busy="true">{t("common.loading")}</p> : null}
        {state.data ? <FieldGroup>
          <Field><FieldLabel htmlFor="cline-provider-options-json">{t("clineRequestOptions.jsonLabel")}</FieldLabel>
            <Button type="button" variant="outline" size="sm" disabled={busy || stale}
              aria-label={t("clineRequestOptions.preset")} title={t("clineRequestOptions.preset")}
              className="h-auto max-w-full justify-start whitespace-normal break-all px-3 py-2 text-left font-mono text-xs"
              onClick={() => setText(requestOptionsPresetText)}>
              {JSON.stringify(requestOptionsPreset)}
            </Button>
            <Textarea id="cline-provider-options-json" className="field-sizing-fixed min-h-72 max-h-[32rem] font-mono text-xs" rows={16} spellCheck={false}
              value={text} disabled={busy || stale} aria-invalid={parsed.error !== undefined}
              aria-describedby="cline-provider-options-hint"
              onChange={event => setText(event.target.value)} />
            <FieldDescription id="cline-provider-options-hint">{t("clineRequestOptions.jsonHint")}</FieldDescription>
          </Field>
          {parsed.error ? <Alert variant="destructive"><AlertDescription>{t(parsed.kind === "json" ? "clineRequestOptions.invalidJson" : "clineRequestOptions.invalidOptions", { message: parsed.error })}</AlertDescription></Alert> : null}
        </FieldGroup> : null}
        {management.error ? <Alert variant="destructive"><AlertDescription>{management.error}</AlertDescription></Alert> : null}
        {management.actionError ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
        {management.readbackRequired ? <Alert><AlertDescription>{t("settingsUi.readbackUnknown")}</AlertDescription></Alert> : null}
      </div>
      <DialogFooter className="shrink-0"><Button variant="outline" disabled={management.busy} onClick={onClose}>{t("modelManagement.cancel")}</Button>
        <Button disabled={disabled} onClick={() => {
          if (disabled || parsed.value === undefined || state.data === null) return
          management.clearError()
          void management.mutate({ operation: "model.request-options", provider: target.provider, model: target.model,
            revision: state.data.revision, providerOptions: parsed.value })
        }}>{t("clineRequestOptions.preview")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function ProviderModelRequestOptionsConfirmation({ preview, saving, loading, finalFocus, onConfirm, onCancel }: {
  preview: RequestOptionsPreview
  saving: boolean
  loading: boolean
  finalFocus: ComponentProps<typeof ManagementConfirmationDialog>["finalFocus"]
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  return <ManagementConfirmationDialog open saving={saving} loading={loading} finalFocus={finalFocus} className={modelOperationDialogClassName}
    title={t("clineRequestOptions.confirmTitle")} description={t("clineRequestOptions.confirmHint")} confirmDisabled={!preview.willChange} onConfirm={onConfirm} onCancel={onCancel}>
    <code className="break-all">{preview.provider} · {preview.model}</code>
    {preview.changes.map(change => <section key={change.field} className="flex flex-col gap-1">
      <p className="font-medium">{t("clineRequestOptions.change", { field: change.field })}</p>
      <div className="grid gap-2 md:grid-cols-2">
        <div><p className="text-xs text-muted-foreground">{t("clineRequestOptions.before")}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{formatValue(change.before, t("clineRequestOptions.absent"))}</pre></div>
        <div><p className="text-xs text-muted-foreground">{t("clineRequestOptions.after")}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">{formatValue(change.after, t("clineRequestOptions.absent"))}</pre></div>
      </div>
    </section>)}
    {preview.changes.length === 0 ? <p>{t("clineRequestOptions.unchanged")}</p> : null}
  </ManagementConfirmationDialog>
}

function parseRequestOptions(text: string): { value: Record<string, unknown> | undefined; error?: string; kind?: "json" | "shape" } {
  let parsed: unknown
  try { parsed = JSON.parse(text) }
  catch (error) { return { value: undefined, error: error instanceof Error ? error.message : String(error), kind: "json" } }
  try { return { value: validateClinePassProviderOptions(parsed) ?? {} } }
  catch (error) { return { value: undefined, error: error instanceof Error ? error.message : String(error), kind: "shape" } }
}

function formatValue(value: { present: boolean; value?: unknown }, absent: string) {
  return value.present ? JSON.stringify(value.value, null, 2) : absent
}
