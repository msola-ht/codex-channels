import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useEffect, useMemo, useState } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { formatModelLabel } from "@/lib/format"

import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldContent, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import { formatTokens } from "@/lib/format"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import type { ProviderSettingsController } from "@/lib/settings-management"

export function ProviderSettingsManagement({ management, onChanged, section }: { management: ProviderSettingsController; onChanged?: () => void; section: "providers" | "models" | "context" }) {
  const { t } = useTranslation()
  const settings = management.settings
  if (management.loading && settings === null) return <LoadingSettingsCard title={t("managementUi.providerSettings")} />
  if (settings === null) return <SettingsError message={management.error ?? t("managementUi.providerSettingsUnavailable")} retry={management.refetch} />
  return <>{management.error !== null ? <SettingsError message={management.error} retry={management.refetch} /> : null}<ProviderSettingsCard settings={settings} management={management} onChanged={onChanged} section={section} /></>
}

function ProviderSettingsCard({
  settings,
  management,
  onChanged,
  section,
}: {
  section: "providers" | "models" | "context"
  settings: ManagementProviderSettingsResponse
  management: ProviderSettingsController
  onChanged?: () => void
}) {
  const { t } = useTranslation()
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState("")
  const [providerName, setProviderName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [mode, setMode] = useState<"switching" | "exclusive">("switching")
  const [model, setModel] = useState("")
  const [catalogKind, setCatalogKind] = useState("official")
  const [customModels, setCustomModels] = useState<Array<{ id: string; name: string; contextWindow: number; maxContextWindow?: number; reasoningEfforts: string[]; defaultReasoningEffort: string | null; supportsImages: boolean; template?: {source: "official" | "deepseek"; model: string; followContext: boolean} }>>([])
  const [supportsWebsockets, setSupportsWebsockets] = useState("true")
  const [apiKey, setApiKey] = useState("")
  const [confirmRemoveBaseUrl, setConfirmRemoveBaseUrl] = useState(false)
  const [managedProvider, setManagedProvider] = useState(settings.managedProviders[0]?.id ?? "")
  const [windowModel, setWindowModel] = useState(settings.modelWindow[0]?.id ?? "")
  const [windowError, setWindowError] = useState<"invalid-percent" | null>(null)

  const managed = settings.managedProviders.find((provider) => provider.id === managedProvider) ?? settings.managedProviders[0]
  const windowEntry = settings.modelWindow.find((candidate) => candidate.id === windowModel) ?? settings.modelWindow[0]
  const [managedDraft, patchManaged, resetManaged] = useSettingsDraft({ model: managed?.model ?? "", reasoning: managed?.reasoningEffort ?? "" })
  const { model: managedModel, reasoning: managedReasoning } = managedDraft
  const managedModelEntry = managed?.models.find((candidate) => candidate.id === managedModel)
  const [windowDraft, patchWindow, resetWindow] = useSettingsDraft({ percent: String(windowEntry?.windowPercent ?? 100) })
  const windowPercent = windowDraft.percent
  const candidates = useMemo(() => [
    ...settings.customProviders.fixedCandidates,
    ...settings.customProviders.switchingProviders,
    ...settings.customProviders.backupCandidates,
  ], [settings.customProviders])
  const busy = management.busy || management.loading || management.error !== null
  const pending = management.pendingPreview

  const managedId = managed?.id
  const windowId = windowEntry?.id
  useEffect(() => { resetManaged() }, [managedId, resetManaged])
  useEffect(() => { resetWindow() }, [windowId, resetWindow])

  const resetForm = () => {
    setEditorOpen(false)
    setEditingId(null)
    setProviderId("")
    setProviderName("")
    setBaseUrl("")
    setMode("switching")
    setModel("")
    setCatalogKind("official")
    setCustomModels([])
    setSupportsWebsockets("true")
    setApiKey("")
    setConfirmRemoveBaseUrl(false)
  }

  const edit = (candidate: typeof candidates[number]) => {
    setEditorOpen(true)
    setCatalogKind(candidate.catalog === "custom" ? "custom" : "official")
    setCustomModels(candidate.models?.map(entry => ({ ...entry, reasoningEfforts: [...entry.reasoningEfforts] })) ?? [])
    setEditingId(candidate.id)
    setProviderId(candidate.id)
    setProviderName(candidate.displayName)
    setBaseUrl(candidate.baseUrl)
    setMode("mode" in candidate && candidate.mode === "switching" ? "switching" : "exclusive")
    setModel("model" in candidate && typeof candidate.model === "string" ? candidate.model : settings.defaults.model ?? "")
    setSupportsWebsockets("supportsWebsockets" in candidate && candidate.supportsWebsockets ? "true" : "false")
    setApiKey("")
    setConfirmRemoveBaseUrl(false)
    management.clearError()
  }

  const saveCustom = async () => {
    const credential = apiKey.trim() === ""
      ? { action: "preserve" as const }
      : { action: "replace" as const, apiKey }
    const result = await management.mutate({
      operation: "primary.custom.save",
      provider: {
        operation: editingId === null ? "create" : "update",
        providerId: providerId.trim(),
        name: providerName.trim(),
        baseUrl: baseUrl.trim(),
        mode,
        model: model.trim(),
        ...(catalogKind === "custom" ? { catalog: { kind: "custom" as const, models: customModels } } : {}),
        supportsWebsockets: supportsWebsockets === "true",
        credential,
        ...(confirmRemoveBaseUrl ? { confirmRemoveTopLevelBaseUrl: true } : {}),
      },
    })
    if (result !== null) resetForm()
  }

  const switchProvider = async (providerIdToSwitch: string) => {
    await management.mutate({ operation: "primary.switch", providerId: providerIdToSwitch })
  }

  const removeProvider = async (providerIdToRemove: string) => {
    await management.mutate({ operation: "primary.remove", providerId: providerIdToRemove })
  }

  const updateManagedDefault = async () => {
    if (managed === undefined || managedModelEntry === undefined) return
    await management.mutate({
      operation: "managed.default",
      provider: managed.id,
      model: managedModelEntry.id,
      reasoningEffort: managedReasoning,
    })
  }

  const updateWindow = async () => {
    if (windowEntry === undefined) return
    const parsedPercent = Number(windowPercent)
    if (!Number.isInteger(parsedPercent) || parsedPercent < 10 || parsedPercent > 100) {
      setWindowError("invalid-percent")
      return
    }
    setWindowError(null)
    await management.mutate({
      operation: "managed.window",
      model: windowEntry.id,
      windowPercent: parsedPercent,
    })
  }



  const cancelPending = () => {
    management.cancel()
    setApiKey("")
  }

  const confirmPending = async () => {
    const operation = management.pendingPreview?.input.operation
    const result = await management.confirm()
    if (result !== null && operation === "primary.custom.save") resetForm()
    if (result !== null && operation === "managed.default") resetManaged()
    if (result !== null && operation === "managed.window") resetWindow()
    if (result !== null) onChanged?.()
  }

  return <Card>
    <CardHeader>
      <CardTitle>{section === "providers" ? t("managementUi.customProviders") : section === "models" ? t("managementUi.managedDefaults") : t("managementUi.managedWindows")}</CardTitle>
      <CardDescription>{section === "providers" ? t("managementUi.customProvidersHint") : section === "models" ? t("managementUi.managedDefaultsHint") : t("managementUi.managedWindowsHint")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-6 text-sm">
      {section === "models" && <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-medium">{t("managementUi.managedDefaults")}</h3><p className="text-xs text-muted-foreground">{t("managementUi.managedDefaultsDetail")}</p></div>
          <Badge variant="outline">{t("managementUi.count", { count: settings.managedProviders.length })}</Badge>
        </div>
        {managed === undefined ? <SettingsEmpty>{t("managementUi.managedProvidersEmpty")}</SettingsEmpty> : <>
          <FieldGroup>
            <ManagedSelect label={t("managementUi.provider")} value={managed.id} options={settings.managedProviders.map((provider) => [provider.id, provider.displayName])} disabled={busy || pending !== null} onChange={setManagedProvider} />
            <ManagedSelect label={t("managementUi.defaultModel")} value={managedModel} options={managed.models.map((candidate) => [candidate.id, formatModelLabel(candidate.id, candidate.displayName)])} disabled={busy || pending !== null} onChange={(value) => patchManaged({ model: value })} />
            <ManagedSelect label={t("managementUi.reasoning")} value={managedReasoning} options={(managedModelEntry?.reasoningEfforts ?? []).map((candidate) => [candidate.effort, candidate.effort])} disabled={busy || pending !== null} onChange={(value) => patchManaged({ reasoning: value })} />
          </FieldGroup>
          <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null || managedModelEntry === undefined} onClick={() => void updateManagedDefault()}>{t("managementUi.saveManagedDefaults")}</Button>
        </>}
      </section>}
      {section === "context" && <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div><h3 className="font-medium">{t("managementUi.modelWindows")}</h3><p className="text-xs text-muted-foreground">{t("managementUi.modelWindowsDetail")}</p></div>
          <Badge variant="outline">{t("managementUi.modelCount", { count: settings.modelWindow.length })}</Badge>
        </div>
        {windowEntry === undefined ? <SettingsEmpty>{t("managementUi.managedModelsEmpty")}</SettingsEmpty> : <>
          <FieldGroup>
            <Table><TableHeader><TableRow><TableHead>{t("modelManagement.model")}</TableHead><TableHead>{t("managementUi.provider")}</TableHead><TableHead>{t("managementUi.windowPercent")}</TableHead><TableHead>{t("modelManagement.actions")}</TableHead></TableRow></TableHeader><TableBody>{settings.modelWindow.map(entry => <TableRow key={entry.id} data-state={entry.id === windowEntry.id ? "selected" : undefined}><TableCell>{entry.displayName}</TableCell><TableCell>{entry.providers.join(t("managementUi.listSeparator"))}</TableCell><TableCell>{entry.conflicts ? t("managementUi.inconsistent") : `${entry.windowPercent ?? 100}%`}</TableCell><TableCell><Button size="sm" variant="outline" disabled={busy || pending !== null || entry.id === windowEntry.id} onClick={() => setWindowModel(entry.id)}>{t("managementUi.select")}</Button></TableCell></TableRow>)}</TableBody></Table>
            <p className="text-sm">{t("managementUi.editingModel", { model: windowEntry.displayName })}</p>
            <Field orientation="responsive" data-invalid={windowError !== null} data-disabled={busy || pending !== null}><FieldLabel className="text-muted-foreground" htmlFor="provider-window-percent">{t("managementUi.windowPercentLabel")}</FieldLabel><FieldContent className="sm:max-w-[220px]"><Input id="provider-window-percent" aria-invalid={windowError !== null} aria-describedby={windowError === null ? undefined : "provider-window-percent-error"} className="w-full sm:w-[160px] sm:self-end" type="number" min={10} max={100} value={windowPercent} disabled={busy || pending !== null} onChange={(event) => { patchWindow({ percent: event.target.value }); setWindowError(null) }} /><FieldError id="provider-window-percent-error" className="sm:text-right">{windowError === null ? null : t("managementUi.windowInvalid")}</FieldError></FieldContent></Field>
          </FieldGroup>
          <p className="text-xs text-muted-foreground">{t("managementUi.windowSummary", { providers: windowEntry.providers.join(t("managementUi.listSeparator")) || t("managementUi.none"), context: formatTokens(windowEntry.contextWindow), max: formatTokens(windowEntry.maxContextWindow) })}</p>
          {windowEntry.conflicts === true ? <Alert><AlertTitle>{t("managementUi.windowConflict")}</AlertTitle><AlertDescription>{t("managementUi.windowConflictDescription", { values: Object.entries(windowEntry.perProvider ?? {}).filter(([, value]) => value !== undefined).map(([provider, value]) => `${provider} ${value}%`).join(t("accountConfirmation.listSeparator")) || t("managementUi.partlyUnset") })}</AlertDescription></Alert> : null}
          <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null || windowEntry === undefined} onClick={() => void updateWindow()}>{t("managementUi.saveWindow")}</Button>
        </>}
      </section>}
      {section === "providers" && <section className="flex flex-col gap-3">
        <div><h3 className="font-medium">{t("managementUi.customProviders")}</h3><p className="text-xs text-muted-foreground">{t("managementUi.customProvidersDetail")}</p></div>
        <div className="flex flex-wrap gap-2"><Button disabled={busy || pending !== null} onClick={() => { resetForm(); management.clearError(); setEditorOpen(true) }}>{t("managementUi.addProvider")}</Button><Button variant="outline" disabled={busy || pending !== null} onClick={() => void switchProvider("openai")}>{t("managementUi.backOfficial")}</Button></div>
        <Table><TableHeader><TableRow><TableHead>{t("managementUi.provider")}</TableHead><TableHead>{t("managementUi.address")}</TableHead><TableHead>{t("channelSettings.state")}</TableHead><TableHead>{t("modelManagement.actions")}</TableHead></TableRow></TableHeader><TableBody>
          {candidates.length === 0 ? <TableRow><TableCell colSpan={4}><SettingsEmpty>{t("managementUi.customProvidersEmpty")}</SettingsEmpty></TableCell></TableRow> : candidates.map(candidate => <TableRow key={candidate.id}>
            <TableCell><div className="flex flex-col gap-1"><span>{candidate.displayName}</span><span className="text-xs text-muted-foreground">{candidate.id}</span></div></TableCell>
            <TableCell className="max-w-64 truncate">{candidate.baseUrl || "—"}</TableCell>
            <TableCell>{"active" in candidate && candidate.active ? <Badge variant="secondary">{t("managementUi.current")}</Badge> : "—"}</TableCell>
            <TableCell><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => edit(candidate)}>{t("modelManagement.edit")}</Button><Button variant="outline" size="sm" disabled={busy || pending !== null} onClick={() => void switchProvider(candidate.id)}>{t("managementUi.switch")}</Button><Button variant="destructive" size="sm" disabled={busy || pending !== null} onClick={() => void removeProvider(candidate.id)}>{t("modelManagement.remove")}</Button></div></TableCell>
          </TableRow>)}
        </TableBody></Table>
        <Dialog open={editorOpen} onOpenChange={open => { if (!open && !management.busy && pending === null) resetForm() }}><DialogContent closeLabel={t("common.close")} showCloseButton={!management.busy && pending === null} className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editingId === null ? t("managementUi.addProvider") : t("managementUi.editProvider")}</DialogTitle><DialogDescription>{t("managementUi.providerEditorHint")}</DialogDescription></DialogHeader>
        <ManagedSelect label={t("managementUi.providerType")} value={catalogKind} options={[["official", t("managementUi.compatibleProvider")], ["custom", t("managementUi.responsesProvider")]]} disabled={busy || pending !== null || editingId !== null} onChange={(value) => { setCatalogKind(value); setProviderId(value === "custom" ? "rs-" : ""); setModel(""); setCustomModels([]) }} />
        <FieldGroup className="grid gap-3 md:grid-cols-2">
          <Field data-disabled={busy || pending !== null || editingId !== null}><FieldLabel htmlFor="custom-provider-id">{catalogKind === "custom" ? t("managementUi.responsesProviderId") : t("managementUi.providerId")}</FieldLabel><Input id="custom-provider-id" placeholder={t("managementUi.providerIdExample")} value={providerId} disabled={busy || pending !== null || editingId !== null} onChange={(event) => setProviderId(event.target.value)} /></Field>
          <Field data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-name">{t("managementUi.displayName")}</FieldLabel><Input id="custom-provider-name" placeholder={t("managementUi.displayName")} value={providerName} disabled={busy || pending !== null} onChange={(event) => setProviderName(event.target.value)} /></Field>
          <Field className="md:col-span-2" data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-endpoint">{t("managementUi.responsesBaseUrl")}</FieldLabel><Input id="custom-provider-endpoint" placeholder="https://example.com/v1" value={baseUrl} disabled={busy || pending !== null} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
          <Field data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-model">{catalogKind === "custom" ? t("managementUi.defaultModelId") : t("managementUi.officialModelId")}</FieldLabel><Input id="custom-provider-model" placeholder={t("managementUi.modelId")} value={model} disabled={busy || pending !== null} onChange={(event) => setModel(event.target.value)} /></Field>
          <ManagedSelect label={t("modelManagement.mode")} value={mode} options={[["switching", t("modelManagement.switching")], ["exclusive", t("modelManagement.exclusive")]]} disabled={busy || pending !== null} onChange={(value) => setMode(value as "switching" | "exclusive")} />
          <ManagedSelect label="WebSocket" value={supportsWebsockets} options={[["true", t("managementUi.supported")], ["false", t("managementUi.unsupported")]]} disabled={busy || pending !== null} onChange={setSupportsWebsockets} />
          <Field className="md:col-span-2" data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-api-key">API Key</FieldLabel><Input id="custom-provider-api-key" type="password" autoComplete="new-password" placeholder={t("managementUi.preserveCredentials")} value={apiKey} disabled={busy || pending !== null} onChange={(event) => setApiKey(event.target.value)} /></Field>
        </FieldGroup>
        {catalogKind === "custom" ? <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t("managementUi.responsesHint")}</p>
          {customModels.map((entry, index) => {
            const patch = (changes: Partial<typeof entry>) => setCustomModels(current => current.map((value, position) => position === index ? { ...value, ...changes } : value))
            return <FieldGroup key={index} className="rounded-md border p-3">
              <Field><FieldLabel htmlFor={`responses-model-${index}`}>{t("managementUi.modelId")}</FieldLabel><Input id={`responses-model-${index}`} value={entry.id} disabled={busy || pending !== null} onChange={event => patch({ id: event.target.value })} /></Field>
              <Field><FieldLabel htmlFor={`responses-name-${index}`}>{t("managementUi.displayName")}</FieldLabel><Input id={`responses-name-${index}`} value={entry.name} disabled={busy || pending !== null} onChange={event => patch({ name: event.target.value })} /></Field>
              {entry.template?.source === "deepseek" ? <Field orientation="horizontal"><Checkbox id={`responses-follow-${index}`} checked={entry.template.followContext} disabled={busy || pending !== null} onCheckedChange={value => patch({template: {...entry.template!, followContext: value === true}})} /><FieldLabel htmlFor={`responses-follow-${index}`}>{t("managementUi.followDsContext", { model: entry.template.model })}</FieldLabel></Field> : null}
              <Field><FieldLabel htmlFor={`responses-context-${index}`}>{t("managementUi.contextTokens")}</FieldLabel><Input id={`responses-context-${index}`} type="number" min={1024} max={entry.maxContextWindow ?? 100000000} value={entry.contextWindow || ""} disabled={busy || pending !== null || entry.template?.followContext === true} onChange={event => patch({ contextWindow: Number(event.target.value) })} /></Field>
              <Field><FieldLabel htmlFor={`responses-reasoning-${index}`}>{t("managementUi.reasoningList")}</FieldLabel><Input id={`responses-reasoning-${index}`} value={entry.reasoningEfforts.join(",")} placeholder="low,medium,high" disabled={busy || pending !== null} onChange={event => { const values = event.target.value === "" ? [] : event.target.value.split(","); patch({ reasoningEfforts: values, defaultReasoningEffort: values.includes(entry.defaultReasoningEffort ?? "") ? entry.defaultReasoningEffort : values[0] ?? null }) }} /></Field>
              {entry.reasoningEfforts.length > 0 ? <Field><FieldLabel htmlFor={`responses-default-${index}`}>{t("managementUi.defaultReasoning")}</FieldLabel><Input id={`responses-default-${index}`} value={entry.defaultReasoningEffort ?? ""} disabled={busy || pending !== null} onChange={event => patch({ defaultReasoningEffort: event.target.value })} /></Field> : null}
              <Field orientation="horizontal"><Checkbox id={`responses-images-${index}`} checked={entry.supportsImages} disabled={busy || pending !== null} onCheckedChange={value => patch({ supportsImages: value === true })} /><FieldLabel htmlFor={`responses-images-${index}`}>{t("managementUi.imageInput")}</FieldLabel></Field>
              <Button variant="outline" disabled={busy || pending !== null} onClick={() => setCustomModels(current => current.filter((_, position) => position !== index))}>{t("managementUi.removeModel")}</Button>
            </FieldGroup>
          })}
          <Button variant="outline" disabled={busy || pending !== null || customModels.length >= 64} onClick={() => setCustomModels(current => [...current, { id: current.length === 0 ? model : "", name: current.length === 0 ? model : "", contextWindow: 0, reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: false }])}>{t("managementUi.addModel")}</Button>
        </div> : null}
        {mode === "exclusive" ? <Field orientation="horizontal" data-disabled={busy || pending !== null}><Checkbox id="custom-provider-remove-base-url" checked={confirmRemoveBaseUrl} disabled={busy || pending !== null} onCheckedChange={(checked) => setConfirmRemoveBaseUrl(checked === true)} /><FieldLabel htmlFor="custom-provider-remove-base-url" className="text-xs text-muted-foreground">{t("managementUi.removeBaseUrl")}</FieldLabel></Field> : null}
        <div className="flex flex-wrap gap-2"><Button disabled={busy || pending !== null || providerId.trim() === "" || providerName.trim() === "" || baseUrl.trim() === "" || model.trim() === "" || (editingId === null && apiKey.trim() === "")} onClick={() => void saveCustom()}>{editingId === null ? t("managementUi.addProvider") : t("managementUi.saveProvider")}</Button>{editingId !== null ? <Button variant="outline" disabled={busy || pending !== null} onClick={resetForm}>{t("managementUi.cancelEditing")}</Button> : null}</div>
        {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
        </DialogContent></Dialog>
      </section>}
      {pending !== null ? <ProviderSettingsConfirmationDialog pending={pending.preview} saving={management.busy} loading={management.loading} onConfirm={() => void confirmPending()} onCancel={cancelPending} /> : null}
      {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
    </CardContent>
  </Card>
}

function ProviderSettingsConfirmationDialog({
  pending,
  saving,
  loading,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<ProviderSettingsController["pendingPreview"]>["preview"]
  saving: boolean
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const lines = [t("accountConfirmation.operation", { value: pending.operation })]
  if (pending.provider !== undefined) lines.push(t("managementUi.providerConfirm", { name: pending.provider.displayName ?? pending.provider.name ?? pending.provider.id }))
  if (pending.provider?.models !== undefined) for (const model of pending.provider.models) lines.push(t("managementUi.modelSummary", { name: model.name, id: model.id, context: model.contextWindow, images: t(model.supportsImages ? "managementUi.supported" : "managementUi.unsupported"), reasoning: model.reasoningEfforts.join("/") || t("managementUi.unsupported"), default: model.defaultReasoningEffort ?? "none" }) + (model.template ? t("managementUi.templateSummary", { source: model.template.source, model: model.template.model, mode: t(model.template.followContext ? "managementUi.follow" : "managementUi.independent") }) : ""))
  if (pending.target !== undefined) lines.push(t("managementUi.targetConfirm", { name: pending.target.displayName, id: pending.target.id }))
  if (pending.model !== undefined) lines.push(t("managementUi.modelConfirm", { name: pending.model.displayName, id: pending.model.id }))
  if (pending.providers !== undefined && pending.providers.length > 0) lines.push(t("managementUi.appliedProviders", { providers: pending.providers.join(t("managementUi.listSeparator")) }))
  if (pending.overridden !== undefined && pending.overridden.length > 0) lines.push(t("managementUi.overridden", { values: pending.overridden.map(entry => t("managementUi.previousPercent", { provider: entry.provider, percent: entry.previousPercent })).join(t("managementUi.listSeparator")) }))
  if (pending.conflicts === true) lines.push(t("managementUi.percentConflictConfirm"))
  if (pending.windowConflict === true) lines.push(t("managementUi.maxWindowConflict"))
  if (pending.reasoningEffort !== undefined) lines.push(t("managementUi.reasoningConfirm", { value: pending.reasoningEffort }))
  if (pending.windowPercent !== undefined) lines.push(t("managementUi.windowConfirm", { percent: pending.windowPercent }))
  if (pending.credential?.action !== undefined) lines.push(t("managementUi.credentialConfirm", { action: t(pending.credential.action === "replace" ? "managementUi.replaceCredential" : "managementUi.preserveCredential") }))
  return <ManagementConfirmationDialog open saving={saving} loading={loading} title={t("managementUi.providerConfirmTitle")} description={t("accountConfirmation.changeDescription")} confirmVariant={pending.operation === "remove" ? "destructive" : "default"} onConfirm={onConfirm} onCancel={onCancel}>
    <p className="whitespace-pre-line">{lines.join("\n")}</p>
    <p className="text-muted-foreground">{t("accountConfirmation.activation", { value: pending.activation })}</p>
  </ManagementConfirmationDialog>
}
