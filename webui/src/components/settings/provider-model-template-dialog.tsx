import { useState, type ComponentProps, type RefObject } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { useApi } from "@/hooks/use-api"
import { useTranslation } from "@/hooks/use-translation"
import { fetchProviderModelTemplateOptions } from "@/lib/api"
import { translateApiError } from "@/lib/i18n/translate"
import type { ProviderSettingsController } from "@/lib/settings-management"
import type { ProviderModelTemplateSection, ProviderModelTemplateUpdatePreview, ProviderModelTemplateValue } from "@/lib/types"

export interface ProviderModelTemplateTarget {
  provider: string
  model: string
  revision: string
}

export function ProviderModelTemplateDialog({ target, open, stale, management, previewRef, finalFocus, onClose }: {
  target: ProviderModelTemplateTarget
  open: boolean
  stale: boolean
  management: ProviderSettingsController
  previewRef: RefObject<HTMLButtonElement | null>
  finalFocus: ComponentProps<typeof DialogContent>["finalFocus"]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const request = useApi(signal => fetchProviderModelTemplateOptions(target.provider, signal), [target.provider], { retainDataOnError: false })
  const [selected, setSelected] = useState<string | null>(null)
  const [sections, setSections] = useState<ProviderModelTemplateSection[]>(["prompts"])
  const options = request.data
  const custom = target.provider.startsWith("cp-")
  const selectedSections = sections.filter(section => options?.availableSections.includes(section))
  const currentTarget = options?.targets.find(entry => entry.model === target.model)
  const templates = options?.templates.filter(entry => !target.provider.startsWith("ds-") && !target.provider.startsWith("clp-") || entry.model === target.model) ?? []
  const initialIndex = currentTarget?.template ? templates.findIndex(entry => entry.source === currentTarget.template?.source && entry.model === currentTarget.template.model) : -1
  const selection = selected ?? (initialIndex < 0 ? "" : String(initialIndex))
  const template = selection === "" ? undefined : templates[Number(selection)]
  const catalogStale = stale
  const busy = management.busy || management.loading || management.error !== null || management.readbackRequired
  const unavailable = !request.loading && request.error === null && (!currentTarget || templates.length === 0)
  const preview = async () => {
    if (!open || busy || request.loading || catalogStale || !options || !currentTarget || !template || selectedSections.length === 0) return
    await management.mutate({ operation: "model.template.update", provider: target.provider, model: target.model,
      revision: options.revision, sourceToken: options.sourceToken, template: { source: template.source, model: template.model }, sections: selectedSections })
  }
  return <Dialog open={open} disablePointerDismissal onOpenChange={(nextOpen, details) => { if (management.busy) { details.cancel(); return }; if (!nextOpen && open) onClose() }}>
    <DialogContent finalFocus={open ? finalFocus : false} closeLabel={t("common.close")} showCloseButton={!management.busy} className="max-h-[85dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>{t("modelTemplate.title")}</DialogTitle><DialogDescription>{t(custom ? "modelTemplate.customHint" : "modelTemplate.hint")}</DialogDescription></DialogHeader>
      <code className="break-all text-xs text-muted-foreground">{target.provider} · {target.model}</code>
      {request.loading ? <p aria-busy="true">{t("common.loading")}</p> : null}
      {request.error ? <Alert variant="destructive"><AlertDescription>{translateApiError(t, request.error, request.errorCode)}</AlertDescription></Alert> : null}
      {unavailable ? <Alert><AlertDescription>{t("modelTemplate.unavailable")}</AlertDescription></Alert> : null}
      {options && !request.loading && !request.error && !unavailable ? <FieldGroup>
        <ManagedSelect fullWidth label={t("modelTemplate.source")} value={selection} placeholder={t("modelTemplate.selectSource")} disabled={busy || catalogStale} options={templates.map((entry, index) => [String(index), `${t(`modelTemplate.${entry.source}`)} · ${entry.displayName} (${entry.model})`])} onChange={setSelected} />
        <FieldSet disabled={busy || catalogStale}><FieldLegend>{t("modelTemplate.sections")}</FieldLegend><FieldGroup>
          {options.availableSections.map(section => <Field key={section} orientation="horizontal"><Checkbox id={`template-${section}`} checked={selectedSections.includes(section)} disabled={busy || catalogStale} onCheckedChange={checked => setSections(previous => checked ? [...previous.filter(value => value !== section), section] : previous.filter(value => value !== section))} /><FieldLabel htmlFor={`template-${section}`}>{t(`modelTemplate.${section}`)}</FieldLabel></Field>)}
        </FieldGroup></FieldSet>
        <p className="text-sm text-muted-foreground">{t("modelTemplate.settingsHint")}</p>
        {selectedSections.includes("capabilities") ? <p className="text-sm text-muted-foreground">{t("modelTemplate.capabilityHint")}</p> : null}
      </FieldGroup> : null}
      {catalogStale ? <Alert variant="destructive"><AlertDescription>{t("modelCatalog.stale")}</AlertDescription></Alert> : null}
      {management.error ? <Alert variant="destructive"><AlertDescription>{management.error}</AlertDescription></Alert> : null}
      {management.readbackRequired ? <Alert><AlertDescription>{t("settingsUi.readbackUnknown")}</AlertDescription></Alert> : null}
      {management.actionError ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
      <DialogFooter><Button variant="outline" disabled={management.busy} onClick={onClose}>{t("modelManagement.cancel")}</Button>
        {management.error ? <Button variant="outline" disabled={management.busy || management.loading} onClick={management.refetch}>{t("common.retry")}</Button> : null}
        {request.error || unavailable || management.actionError && !catalogStale ? <Button variant="outline" disabled={busy || request.loading} onClick={() => { setSelected(null); management.clearError(); request.refetch() }}>{t("modelTemplate.retry")}</Button> : null}
        <Button ref={previewRef} disabled={busy || request.loading || request.error !== null || catalogStale || !currentTarget || !template || selectedSections.length === 0} onClick={() => void preview()}>{t("modelManagement.preview")}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

export function ProviderModelTemplateConfirmation({ preview, saving, loading, finalFocus, onConfirm, onCancel }: {
  preview: ProviderModelTemplateUpdatePreview
  saving: boolean
  loading?: boolean
  finalFocus?: ComponentProps<typeof ManagementConfirmationDialog>["finalFocus"]
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const value = (field: ProviderModelTemplateValue) => field.present ? JSON.stringify(field.value, null, 2) : t("modelTemplate.absent")
  return <ManagementConfirmationDialog open saving={saving} loading={loading} finalFocus={finalFocus} title={t("modelTemplate.confirmTitle")} description={t(preview.provider.startsWith("cp-") ? "modelTemplate.customConfirmHint" : "modelTemplate.confirmHint")} confirmDisabled={!preview.willChange} onConfirm={onConfirm} onCancel={onCancel}>
    <code className="break-all">{preview.provider} · {preview.model}</code>
    <p>{t("modelTemplate.sourceSummary", { source: t(`modelTemplate.${preview.source}`), model: preview.sourceModel })}</p>
    <p>{t("modelTemplate.sectionSummary", { sections: preview.sections.map(section => t(`modelTemplate.${section}`)).join(t("managementUi.listSeparator")) })}</p>
    {!preview.willChange ? <p>{t("modelTemplate.unchanged")}</p> : null}
    {preview.changes.map(change => <section key={change.field} className="flex min-w-0 flex-col gap-2 py-2">
      <h4 className="font-medium break-all">{change.field}</h4>
      <p className="text-muted-foreground">{t("modelTemplate.before")}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{value(change.before)}</pre>
      <p className="text-muted-foreground">{t("modelTemplate.after")}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{value(change.after)}</pre>
    </section>)}
  </ManagementConfirmationDialog>
}
