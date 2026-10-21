import { useState, type ComponentProps, type RefObject } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { useTranslation } from "@/hooks/use-translation"
import { useProviderModelAdditionOptions } from "@/hooks/use-provider-model-addition-options"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import type { ProviderSettingsController } from "@/lib/settings-management"
import type { ManagedManualModelDefinition, ProviderModelAdditionPreview } from "../../../../scripts/provider-model-additions.mjs"
import { contextWindowPresetLabel, contextWindowPresetTokens } from "../../../../runtime/model-catalog.mjs"

export interface ProviderModelAdditionTarget { provider: string; revision: string; models: Array<{ id: string; displayName: string }> }

const reasoningLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

export function ProviderModelAdditionDialog({ target, open, stale, management, previewRef, finalFocus, onClose }: {
  target: ProviderModelAdditionTarget
  open: boolean
  stale: boolean
  management: ProviderSettingsController
  previewRef: RefObject<HTMLButtonElement | null>
  finalFocus: ComponentProps<typeof DialogContent>["finalFocus"]
  onClose: () => void
}) {
  const { t } = useTranslation()
  const clinePass = target.provider.startsWith("clp-")
  const [mode, setMode] = useState("discover")
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [manualSource, setManualSource] = useState("independent")
  const [inheritFrom, setInheritFrom] = useState("")
  const [window, setWindow] = useState("")
  const [efforts, setEfforts] = useState<string[]>([])
  const [effort, setEffort] = useState("")
  const [images, setImages] = useState("unknown")
  const [patch, setPatch] = useState("unknown")
  const [search, setSearch] = useState("unknown")
  const busy = management.busy || management.loading || management.error !== null || management.readbackRequired
  const candidates = useProviderModelAdditionOptions(target, open, stale, busy)
  const { options, selected, loading, errorCode, setSelected, clearError } = candidates
  const locked = busy || loading || stale
  const inheriting = clinePass && manualSource === "inherit"
  const capabilitiesValid = /^\d+$/u.test(window)
    && Number.isSafeInteger(Number(window)) && Number(window) >= 1024 && Number(window) <= 100_000_000
    && efforts.length > 0 && efforts.includes(effort) && [images, patch, search].every(value => value !== "unknown")
  const manualValid = id.trim().length > 0 && name.trim().length > 0
    && (inheriting ? target.models.some(entry => entry.id === inheritFrom) : capabilitiesValid)
  const load = async () => {
    if (locked || !open || mode === "manual" && !manualValid) return
    management.clearError()
    const manualModel: ManagedManualModelDefinition | undefined = mode !== "manual" ? undefined : inheriting ? {
      id: id.trim(), name: name.trim(), inheritFrom,
    } : {
      id: id.trim(), name: name.trim(), contextWindow: Number(window), reasoningEfforts: efforts, defaultReasoningEffort: effort,
      ...(images === "unknown" ? {} : { supportsImages: images === "yes" }),
      ...(patch === "unknown" ? {} : { applyPatchToolType: patch === "yes" ? "freeform" : null }),
      ...(search === "unknown" ? {} : { supportsSearchTool: search === "yes" }),
    }
    await candidates.load(manualModel)
  }
  const capabilityOptions: [string, string][] = [["unknown", t("common.unknown")], ["yes", t("managementUi.supported")], ["no", t("managementUi.unsupported")]]
  return <Dialog open={open} disablePointerDismissal onOpenChange={(next, details) => { if (management.busy) { details.cancel(); return }; if (!next && open) onClose() }}>
    <DialogContent initialFocus={options && selected.length > 0 && !locked ? previewRef : undefined} finalFocus={open ? finalFocus : false} closeLabel={t("common.close")} showCloseButton={!management.busy} className="max-h-[85dvh] overflow-y-auto">
      <DialogHeader><DialogTitle>{t("modelAddition.title")}</DialogTitle><DialogDescription>{t("modelAddition.hint")}</DialogDescription></DialogHeader>
      <code className="break-all">{target.provider}</code>
      {!options ? <FieldGroup>
        <ManagedSelect label={t("modelAddition.method")} value={mode} disabled={locked} options={[["discover", t("modelAddition.discover")], ["manual", t("modelAddition.manual")]]} onChange={value => { setMode(value); clearError() }} />
        {mode === "manual" ? <>
          {clinePass ? <>
            <FieldSet disabled={locked}><FieldLegend>{t("modelAddition.manualSource")}</FieldLegend><ToggleGroup variant="outline" size="sm" value={[manualSource]} disabled={locked} aria-label={t("modelAddition.manualSource")} onValueChange={values => { if (values[0]) { setManualSource(values[0]); clearError() } }}>
              <ToggleGroupItem value="independent">{t("modelAddition.independent")}</ToggleGroupItem>
              <ToggleGroupItem value="inherit">{t("modelAddition.inherit")}</ToggleGroupItem>
            </ToggleGroup></FieldSet>
            <p className="text-sm text-muted-foreground">{t(inheriting ? "modelAddition.clineInheritHint" : "modelAddition.clineManualHint")}</p>
          </> : null}
          <Field><FieldLabel htmlFor="addition-id">{t("managementUi.modelId")}</FieldLabel><Input id="addition-id" value={id} disabled={locked} onChange={event => setId(event.target.value)} /></Field>
          <Field><FieldLabel htmlFor="addition-name">{t("managementUi.displayName")}</FieldLabel><Input id="addition-name" value={name} disabled={locked} onChange={event => setName(event.target.value)} /></Field>
          {inheriting ? <>
            <ManagedSelect fullWidth label={t("modelAddition.inheritFrom")} placeholder={t("modelAddition.selectInheritSource")} value={inheritFrom} disabled={locked} options={target.models.map(entry => [entry.id, `${entry.displayName} (${entry.id})`])} onChange={setInheritFrom} />
            {target.models.length === 0 ? <p>{t("modelAddition.noInheritSource")}</p> : null}
          </> : <>
          <ManagedSelect label={t("managementUi.contextPreset")} value={window} disabled={locked} options={contextWindowPresetTokens.map(value => [String(value), `${contextWindowPresetLabel(value)} (${value})`])} onChange={setWindow} />
          <Field><FieldLabel htmlFor="addition-window">{t("managementUi.contextTokens")}</FieldLabel><Input id="addition-window" type="number" min={1024} max={100000000} value={window} disabled={locked} onChange={event => setWindow(event.target.value)} /></Field>
          <FieldSet disabled={locked}><FieldLegend>{t("modelAddition.reasoning")}</FieldLegend><FieldGroup>{(clinePass ? ["none", "enabled", ...reasoningLevels.slice(1)] : reasoningLevels).map(value => <Field key={value} orientation="horizontal"><Checkbox id={`addition-${value}`} checked={efforts.includes(value)} disabled={locked} onCheckedChange={checked => {
            const next = checked ? [...efforts, value] : efforts.filter(entry => entry !== value)
            setEfforts(next); if (!next.includes(effort)) setEffort(next[0] ?? "")
          }} /><FieldLabel htmlFor={`addition-${value}`}>{value}</FieldLabel></Field>)}</FieldGroup></FieldSet>
          <ManagedSelect label={t("managementUi.defaultReasoning")} value={effort} disabled={locked} options={efforts.map(value => [value, value])} onChange={setEffort} />
          <ManagedSelect label={t("managementUi.imageInput")} value={images} disabled={locked} options={capabilityOptions} onChange={setImages} />
          <ManagedSelect label="apply_patch" value={patch} disabled={locked} options={capabilityOptions} onChange={setPatch} />
          <ManagedSelect label="tool_search" value={search} disabled={locked} options={capabilityOptions} onChange={setSearch} />
          </>}
        </> : null}
        <Button disabled={locked || mode === "manual" && !manualValid} onClick={() => void load()}>{t(loading ? "common.loading" : "modelAddition.load")}</Button>
      </FieldGroup> : <FieldGroup>
        <p>{t("modelCatalog.scope", { providers: options.providers.join(t("managementUi.listSeparator")) })}</p>
        {options.candidates.length === 0 ? <p>{t("modelAddition.empty")}</p> : <FieldSet disabled={locked}><FieldLegend>{t("modelAddition.select")}</FieldLegend><FieldGroup>{options.candidates.map((entry, index) => <Field key={entry.model} orientation="horizontal"><Checkbox id={`addition-candidate-${index}`} checked={selected.includes(entry.model)} disabled={locked} onCheckedChange={checked => setSelected(previous => checked ? [...previous, entry.model] : previous.filter(model => model !== entry.model))} /><FieldLabel htmlFor={`addition-candidate-${index}`} className="break-all">{entry.displayName} ({entry.model})</FieldLabel></Field>)}</FieldGroup></FieldSet>}
        <Button variant="outline" disabled={locked} onClick={() => { candidates.reset(); management.clearError() }}>{t("modelAddition.reset")}</Button>
      </FieldGroup>}
      {errorCode ? <Alert variant="destructive"><AlertDescription>{translateApiErrorCode(t, errorCode)}</AlertDescription></Alert> : null}
      {stale ? <Alert variant="destructive"><AlertDescription>{t("modelCatalog.stale")}</AlertDescription></Alert> : null}
      {management.actionError ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
      {management.readbackRequired ? <Alert><AlertDescription>{t("settingsUi.readbackUnknown")}</AlertDescription></Alert> : null}
      <DialogFooter><Button variant="outline" disabled={management.busy} onClick={onClose}>{t("modelManagement.cancel")}</Button><Button ref={previewRef} disabled={locked || !options || selected.length === 0} onClick={() => {
        if (options && !locked) void management.mutate({ operation: "model.add", provider: target.provider, revision: options.revision, sourceToken: options.sourceToken, models: selected })
      }}>{t("modelManagement.preview")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>
}

export function ProviderModelAdditionConfirmation({ preview, saving, loading, finalFocus, onConfirm, onCancel }: {
  preview: ProviderModelAdditionPreview
  saving: boolean
  loading: boolean
  finalFocus: ComponentProps<typeof ManagementConfirmationDialog>["finalFocus"]
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  return <ManagementConfirmationDialog open saving={saving} loading={loading} finalFocus={finalFocus} title={t("modelAddition.confirm")} description={t("modelAddition.hint")} confirmDisabled={!preview.willChange} onConfirm={onConfirm} onCancel={onCancel}>
    <p>{t("modelCatalog.scope", { providers: preview.providers.join(t("managementUi.listSeparator")) })}</p>
    {preview.additions.map(entry => <section key={entry.model} className="flex min-w-0 flex-col gap-2"><p>{entry.displayName} ({entry.model})</p>
      {entry.inheritedFrom ? <><p>{t("modelAddition.inheritedSummary", { model: entry.inheritedFrom })}</p><p>{t("modelAddition.inheritedConfirmation")}</p></> : null}
      {entry.clineRequestProfile ? <p>{t("modelAddition.requestProfileSummary", { profile: t(entry.clineRequestProfile === "deepseek-flash" ? "modelAddition.deepseekFlashProfile" : "modelAddition.standardProfile") })}</p> : null}
      {entry.template ? <p>{t("modelTemplate.sourceSummary", { source: t(`modelTemplate.${entry.template.source}`), model: entry.template.model })}</p> : null}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(entry.fields, null, 2)}</pre>
    </section>)}
    <p>{t("settingsUi.command", { value: "codexc restart all" })}</p>
  </ManagementConfirmationDialog>
}
