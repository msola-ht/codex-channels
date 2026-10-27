import { useState, type ComponentProps, type RefObject } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { SettingsEmpty } from "@/components/settings/settings-feedback"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ManagedSelect, ManagementConfirmationDialog, modelOperationDialogClassName, modelOperationFormDialogClassName } from "@/components/settings/settings-controls"
import { ModelCapabilityFields, ModelIdentityFields } from "@/components/settings/model-definition-fields"
import { useTranslation } from "@/hooks/use-translation"
import { useProviderModelAdditionOptions } from "@/hooks/use-provider-model-addition-options"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { validContextWindow } from "@/lib/model-context-window"
import type { ProviderSettingsController } from "@/lib/settings-management"
import type { ManagedManualModelDefinition, ProviderModelAdditionPreview } from "../../../../scripts/provider-model-additions.mjs"
import { defaultModelDisplayName } from "../../../../runtime/model-catalog.mjs"
import { cn } from "cn"

export interface ProviderModelAdditionTarget { provider: string; providers: string[]; revision: string; models: Array<{ id: string; displayName: string }> }

export function ProviderModelAdditionDialog({ target, open, stale, management, previewRef, finalFocus, onClose }: {
  target: ProviderModelAdditionTarget
  open: boolean
  stale: boolean
  management: ProviderSettingsController
  previewRef: RefObject<HTMLButtonElement | null>
  finalFocus: ComponentProps<typeof DialogContent>["finalFocus"]
  onClose: () => void
}) {
  const { t, language } = useTranslation()
  const clinePass = target.provider.startsWith("clp-")
  const custom = target.provider.startsWith("cp-")
  const ollamaCloud = target.provider.startsWith("olc-")
  const [mode, setMode] = useState(ollamaCloud ? "managed" : "manual")
  const [additionProvider, setAdditionProvider] = useState(target.provider)
  const [id, setId] = useState("")
  const [name, setName] = useState("")
  const [manualSource, setManualSource] = useState("independent")
  const [inheritFrom, setInheritFrom] = useState("")
  const [window, setWindow] = useState("")
  const [efforts, setEfforts] = useState<string[]>([])
  const [effort, setEffort] = useState("")
  const [images, setImages] = useState("unknown")
  const [patch, setPatch] = useState(ollamaCloud ? "no" : "unknown")
  const [search, setSearch] = useState(ollamaCloud ? "no" : "unknown")
  const [discoveryModel, setDiscoveryModel] = useState("")
  const [verificationEfforts, setVerificationEfforts] = useState<string[]>([])
  const [paidConfirmed, setPaidConfirmed] = useState(false)
  const busy = management.busy || management.loading || management.error !== null || management.readbackRequired
  const candidates = useProviderModelAdditionOptions({ provider: additionProvider, revision: target.revision }, open, stale, busy)
  const { options, selected, loading, errorCode, setSelected, clearError } = candidates
  const locked = busy || loading || stale
  const discovered = options?.discovery?.find(candidate => candidate.id === discoveryModel && candidate.status === "candidate" && !candidate.alreadySaved)
  const inheriting = manualSource === "inherit"
  const capabilitiesValid = validContextWindow(window, 1024, 100_000_000)
    && efforts.length > 0 && efforts.includes(effort) && [images, patch, search].every(value => value !== "unknown")
  const duplicateId = target.models.some(model => model.id === id.trim())
  const manualValid = id.trim().length > 0 && name.trim().length > 0 && !duplicateId
    && (inheriting ? target.models.some(entry => entry.id === inheritFrom) : capabilitiesValid)
  const cacheDates = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "medium" })
  const load = async (refresh = false) => {
    if (locked || !open || mode === "manual" && !manualValid) return
    management.clearError()
    if (mode !== "manual") { setDiscoveryModel(""); setVerificationEfforts([]); setPaidConfirmed(false) }
    const manualModel: ManagedManualModelDefinition | undefined = mode !== "manual" ? undefined : inheriting ? {
      id: id.trim(), name: name.trim(), inheritFrom,
    } : {
      id: id.trim(), name: name.trim(), contextWindow: Number(window), reasoningEfforts: efforts, defaultReasoningEffort: effort,
      ...(images === "unknown" ? {} : { supportsImages: images === "yes" }),
      ...(patch === "unknown" ? {} : { applyPatchToolType: patch === "yes" ? "freeform" : null }),
      ...(search === "unknown" ? {} : { supportsSearchTool: search === "yes" }),
    }
    await candidates.load(manualModel, mode === "discover" && ollamaCloud, refresh)
  }
  return <Dialog open={open} disablePointerDismissal onOpenChange={(next, details) => { if (management.busy) { details.cancel(); return }; if (!next && open) onClose() }}>
    <DialogContent initialFocus={options && selected.length > 0 && !locked ? previewRef : undefined} finalFocus={open ? finalFocus : false} closeLabel={t("common.close")} showCloseButton={!management.busy} className={cn(modelOperationDialogClassName, modelOperationFormDialogClassName)}>
      <DialogHeader className="shrink-0"><DialogTitle>{t("modelAddition.title")}</DialogTitle><DialogDescription>{t("modelAddition.hint")}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 min-w-0 flex-col gap-6 overflow-y-auto">
      <code className="break-all">{additionProvider}</code>
      {ollamaCloud ? <Alert><AlertDescription>{t("modelAddition.ollamaHint")}</AlertDescription></Alert> : null}
      {ollamaCloud ? <>
        <p className="text-sm text-muted-foreground">{t("modelAddition.discoveryCacheHint")}</p>
        {options?.discoveryCache ? <p className="text-sm text-muted-foreground">{t("modelAddition.discoveryCacheStatus", {
          source: t(options.discoveryCache.hit ? "modelAddition.discoveryCacheHit" : "modelAddition.discoveryCacheFetched"),
          fetchedAt: cacheDates.format(new Date(options.discoveryCache.fetchedAt)), expiresAt: cacheDates.format(new Date(options.discoveryCache.expiresAt)),
        })}</p> : null}
        <Button variant="outline" disabled={locked} onClick={() => void load(true)}>{t("modelAddition.forceRefresh")}</Button>
      </> : null}
      {!options ? <FieldGroup>
        <FieldGroup className={cn("grid min-w-0 gap-6", !custom && mode === "manual" && !inheriting && "sm:grid-cols-2")}>
          {!custom ? <FieldSet disabled={locked}><FieldLegend>{t("modelAddition.method")}</FieldLegend><ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[mode]} disabled={locked} aria-label={t("modelAddition.method")} onValueChange={values => { if (values[0]) { setMode(values[0]); clearError() } }}>
            {ollamaCloud ? <ToggleGroupItem value="managed">{t("modelAddition.ollamaManaged")}</ToggleGroupItem> : null}
            {!ollamaCloud ? <ToggleGroupItem value="manual">{t("modelAddition.manual")}</ToggleGroupItem> : null}
            <ToggleGroupItem value="discover">{t(ollamaCloud ? "modelAddition.ollamaDiscover" : "modelAddition.discover")}</ToggleGroupItem>
          </ToggleGroup></FieldSet> : null}
          {mode === "manual" ? <FieldSet disabled={locked}><FieldLegend>{t("modelAddition.manualSource")}</FieldLegend><ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[manualSource]} disabled={locked} aria-label={t("modelAddition.manualSource")} onValueChange={values => { if (values[0]) { setManualSource(values[0]); clearError() } }}>
            <ToggleGroupItem value="independent">{t("modelAddition.independent")}</ToggleGroupItem>
            <ToggleGroupItem value="inherit">{t("modelAddition.inherit")}</ToggleGroupItem>
          </ToggleGroup></FieldSet> : null}
        </FieldGroup>
        {ollamaCloud && mode === "discover" ? <ManagedSelect fullWidth label={t("modelAddition.verificationAccount")} value={additionProvider} disabled={locked} options={target.providers.map(value => [value, value])} onChange={value => { setAdditionProvider(value); setDiscoveryModel(""); setVerificationEfforts([]); setPaidConfirmed(false) }} /> : null}
        {mode === "manual" ? <>
          <p className="text-sm text-muted-foreground">{t(inheriting ? "modelAddition.clineInheritHint" : clinePass ? "modelAddition.clineManualHint" : "modelAddition.manualHint")}</p>
          <ModelIdentityFields id={id} name={name} disabled={locked} singleColumn={inheriting} idError={duplicateId ? t("modelAddition.duplicateId") : undefined} onIdChange={next => { if (name === "" || name === defaultModelDisplayName(id)) setName(defaultModelDisplayName(next)); setId(next) }} onNameChange={setName} />
          {inheriting ? <>
            <ManagedSelect fullWidth label={t("modelAddition.inheritFrom")} placeholder={t("modelAddition.selectInheritSource")} value={inheritFrom} disabled={locked} options={target.models.map(entry => [entry.id, `${entry.displayName} (${entry.id})`])} onChange={setInheritFrom} />
            {target.models.length === 0 ? <p>{t("modelAddition.noInheritSource")}</p> : null}
          </> : <ModelCapabilityFields disabled={locked} allowReasoningToggle={clinePass} value={{ contextWindow: window, reasoningEfforts: efforts, defaultReasoningEffort: effort || null,
            supportsImages: images === "unknown" ? undefined : images === "yes", supportsPatch: patch === "unknown" ? undefined : patch === "yes", supportsSearch: search === "unknown" ? undefined : search === "yes" }} onChange={changes => {
              if (changes.contextWindow !== undefined) setWindow(changes.contextWindow)
              if (changes.reasoningEfforts !== undefined) setEfforts(changes.reasoningEfforts)
              if (Object.hasOwn(changes, "defaultReasoningEffort")) setEffort(changes.defaultReasoningEffort ?? "")
              if (Object.hasOwn(changes, "supportsImages")) setImages(changes.supportsImages === undefined ? "unknown" : changes.supportsImages ? "yes" : "no")
              if (Object.hasOwn(changes, "supportsPatch")) setPatch(changes.supportsPatch === undefined ? "unknown" : changes.supportsPatch ? "yes" : "no")
              if (Object.hasOwn(changes, "supportsSearch")) setSearch(changes.supportsSearch === undefined ? "unknown" : changes.supportsSearch ? "yes" : "no")
            }} />}
        </> : null}
        <Button disabled={locked || mode === "manual" && !manualValid} onClick={() => void load()}>{loading && <Spinner aria-label={t("common.loading")} data-icon="inline-start" />}{t(loading ? "common.loading" : mode === "manual" ? "modelAddition.load" : mode === "managed" ? "modelAddition.ollamaManagedLoad" : ollamaCloud ? "modelAddition.ollamaDiscoverLoad" : "modelAddition.discoverLoad")}</Button>
      </FieldGroup> : <FieldGroup>
        <p>{t("modelCatalog.scope", { providers: options.providers.join(t("managementUi.listSeparator")) })}</p>
        {ollamaCloud && mode === "managed" ? <>
          <p>{t("modelAddition.remoteMetadataHint")}</p>
          {options.discovery?.filter(entry => entry.alreadySaved || entry.status !== "candidate").map(entry => <p key={entry.id} className="break-all"><code>{entry.id}</code> — {t(entry.alreadySaved ? "modelAddition.discoverySaved" : entry.status === "excluded" ? "modelAddition.discoveryExcluded" : "modelAddition.discoveryUnconfirmed")}{entry.reasonCode ? ` · ${t(`modelAddition.discoveryReasons.${entry.reasonCode}`)}` : ""}</p>)}
        </> : null}
        {mode === "discover" && ollamaCloud && options.discovery ? <>
          <p>{t("modelAddition.discoveryReadonly")}</p>
          {options.discovery.map(entry => <p key={entry.id} className="break-all"><code>{entry.id}</code> — {t(entry.alreadySaved ? "modelAddition.discoverySaved" : entry.status === "candidate" ? "modelAddition.discoveryCandidate" : entry.status === "excluded" ? "modelAddition.discoveryExcluded" : "modelAddition.discoveryUnconfirmed")}{entry.reasonCode ? ` · ${t(`modelAddition.discoveryReasons.${entry.reasonCode}`)}` : ""}</p>)}
          <ManagedSelect fullWidth label={t("modelAddition.discoveryModel")} placeholder={t("modelAddition.discoveryModel")} value={discoveryModel} disabled={locked} options={options.discovery.filter(entry => entry.status === "candidate" && !entry.alreadySaved).map(entry => [entry.id, entry.id])} onChange={value => { setDiscoveryModel(value); setVerificationEfforts([options.discovery?.find(entry => entry.id === value)?.defaultReasoningEffort ?? ""].filter(Boolean)); setPaidConfirmed(false) }} />
          {discovered ? <>
            <p>{t("modelAddition.discoveryWindow", { window: discovered.proposedContextWindow ?? 0, effort: discovered.defaultReasoningEffort ?? "" })}</p>
            {discovered.reasoningMode === "toggle" ? <p>{t("modelAddition.reasoningToggleHint")}</p> : null}
            <FieldSet disabled={locked}><FieldLegend>{t("modelAddition.reasoning")}</FieldLegend><FieldGroup>{discovered.reasoningEfforts?.map((level, index) => <Field key={level} orientation="horizontal"><Checkbox id={`verification-effort-${index}`} checked={verificationEfforts.includes(level)} disabled={locked || level === discovered.defaultReasoningEffort} onCheckedChange={checked => { setVerificationEfforts(previous => checked ? [...previous, level] : previous.filter(value => value !== level)); setPaidConfirmed(false) }} /><FieldLabel htmlFor={`verification-effort-${index}`}>{level}</FieldLabel></Field>)}</FieldGroup></FieldSet>
            <Alert><AlertDescription>{t("modelAddition.paidVerificationHint", { provider: additionProvider, model: discoveryModel, levels: verificationEfforts.join("/"), defaultEffort: discovered.defaultReasoningEffort ?? "", requests: verificationEfforts.length * 2 + 2 })}</AlertDescription></Alert>
            <Field orientation="horizontal"><Checkbox id="olc-paid-verification-confirm" checked={paidConfirmed} disabled={locked} onCheckedChange={value => setPaidConfirmed(value === true)} /><FieldLabel htmlFor="olc-paid-verification-confirm">{t("modelAddition.paidVerificationConfirm")}</FieldLabel></Field>
            <Button disabled={locked || !paidConfirmed || !verificationEfforts.includes(discovered.defaultReasoningEffort ?? "")} onClick={() => { setPaidConfirmed(false); void candidates.verify(discoveryModel, verificationEfforts) }}>{loading ? <Spinner aria-label={t("common.loading")} data-icon="inline-start" /> : null}{t("modelAddition.verify")}</Button>
          </> : null}
        </> : options.candidates.length === 0 ? <SettingsEmpty>{t("modelAddition.empty")}</SettingsEmpty> : <FieldSet disabled={locked}><FieldLegend>{t("modelAddition.select")}</FieldLegend><FieldGroup>{options.candidates.map((entry, index) => <FieldGroup key={entry.model}>
          <Field orientation="horizontal"><Checkbox id={`addition-candidate-${index}`} checked={selected.includes(entry.model)} disabled={locked} onCheckedChange={checked => setSelected(previous => checked ? [...previous, entry.model] : previous.filter(model => model !== entry.model))} /><FieldLabel htmlFor={`addition-candidate-${index}`} className="break-all">{entry.displayName} ({entry.model})</FieldLabel></Field>
          {ollamaCloud && entry.upstreamContextWindow !== undefined ? <p className="text-sm text-muted-foreground">{t("modelAddition.remoteCapabilities", { upstream: entry.upstreamContextWindow, context: String(entry.fields.context_window ?? ""), levels: Array.isArray(entry.fields.supported_reasoning_levels) ? entry.fields.supported_reasoning_levels.map(level => level.effort).join("/") : "", effort: String(entry.fields.default_reasoning_level ?? ""), images: t(Array.isArray(entry.fields.input_modalities) && entry.fields.input_modalities.includes("image") ? "managementUi.supported" : "managementUi.unsupported") })}</p> : null}
          {entry.reasoningMode === "toggle" ? <p className="text-sm text-muted-foreground">{t("modelAddition.reasoningToggleHint")}</p> : null}
        </FieldGroup>)}</FieldGroup></FieldSet>}
        {options.candidates.some(entry => entry.ollamaVerification) ? <Alert><AlertDescription>{t("modelAddition.verifiedHint")}</AlertDescription></Alert> : null}
        <Button variant="outline" disabled={locked} onClick={() => { candidates.reset(); management.clearError(); setDiscoveryModel(""); setVerificationEfforts([]); setPaidConfirmed(false) }}>{t("modelAddition.reset")}</Button>
      </FieldGroup>}
      {errorCode ? <Alert variant="destructive"><AlertDescription>{translateApiErrorCode(t, errorCode)}</AlertDescription></Alert> : null}
      {candidates.auditDegraded ? <Alert><AlertDescription>{t("modelAddition.verificationAuditDegraded")}</AlertDescription></Alert> : null}
      {stale ? <Alert variant="destructive"><AlertDescription>{t("modelCatalog.stale")}</AlertDescription></Alert> : null}
      {management.actionError ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
      {management.readbackRequired ? <Alert><AlertDescription>{t("settingsUi.readbackUnknown")}</AlertDescription></Alert> : null}
      </div>
      <DialogFooter className="shrink-0"><Button variant="outline" disabled={management.busy} onClick={onClose}>{t("modelManagement.cancel")}</Button><Button ref={previewRef} disabled={locked || !options || selected.length === 0} onClick={() => {
        if (options && !locked) void management.mutate({ operation: "model.add", provider: additionProvider, revision: options.revision, sourceToken: options.sourceToken, models: selected })
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
  return <ManagementConfirmationDialog open saving={saving} loading={loading} finalFocus={finalFocus} className={modelOperationDialogClassName} title={t("modelAddition.confirm")} description={t("modelAddition.confirmHint")} confirmDisabled={!preview.willChange} onConfirm={onConfirm} onCancel={onCancel}>
    <p>{t("modelCatalog.scope", { providers: preview.providers.join(t("managementUi.listSeparator")) })}</p>
    {preview.additions.map(entry => <section key={entry.model} className="flex min-w-0 flex-col gap-2"><p>{entry.displayName} ({entry.model})</p>
      {entry.upstreamContextWindow !== undefined ? <p>{t("modelAddition.upstreamWindow", { value: entry.upstreamContextWindow })}</p> : null}
      {entry.inheritedFrom ? <><p>{t("modelAddition.inheritedSummary", { model: entry.inheritedFrom })}</p><p>{t("modelAddition.inheritedConfirmation")}</p></> : null}
      {entry.clineRequestProfile ? <p>{t("modelAddition.requestProfileSummary", { profile: t(entry.clineRequestProfile === "deepseek-flash" ? "modelAddition.deepseekFlashProfile" : "modelAddition.standardProfile") })}</p> : null}
      {entry.clineProviderOptions ? <p className="break-all font-mono text-xs">{t("clineRequestOptions.jsonLabel")}: {JSON.stringify(entry.clineProviderOptions)}</p> : null}
      {entry.template ? <p>{t("modelTemplate.sourceSummary", { source: t(`modelTemplate.${entry.template.source}`), model: entry.template.model })}</p> : null}
      {entry.ollamaVerification ? <p>{t("modelAddition.verifiedSummary", { levels: entry.ollamaVerification.reasoningEfforts.join("/"), jsonEffort: entry.ollamaVerification.jsonReasoningEffort, at: entry.ollamaVerification.verifiedAt, requests: entry.ollamaVerification.requests })}</p> : null}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify(entry.fields, null, 2)}</pre>
    </section>)}
    {preview.provider.startsWith("olc-") ? <p>{t("modelAddition.optionalTemplateHint")}</p> : null}
    <p>{t("settingsUi.command", { value: "codexc restart all" })}</p>
  </ManagementConfirmationDialog>
}
