import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { formatModelLabel } from "@/lib/format"

import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { useCustomModelCapabilityProbe } from "@/hooks/use-custom-model-capability-probe"
import { translateApiErrorCode } from "@/lib/i18n/translate"
import { translateCustomModelProbeReason } from "@/lib/custom-model-probe"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedSelect, ManagementConfirmationDialog, SettingsMutationFeedback } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import type { ProviderSettingsController } from "@/lib/settings-management"
import type { MessageKey } from "@/lib/i18n/messages"
import { CustomModelDetails, CustomModelDetailsPreview } from "@/components/settings/custom-model-details"
import type { ModelCatalogGroup } from "@/components/settings/model-catalog-columns"
import { OpenAiModelDetails } from "@/components/settings/openai-model-details"
import { ModelContextWindowFields } from "@/components/settings/model-context-window-fields"
import { contextWindowPreset, validContextWindow, type ContextWindowPreset } from "@/lib/model-context-window"
import type { CustomModelDraft } from "@/components/settings/custom-model-details"
import { contextWindowPresetTokens } from "../../../../runtime/model-catalog.mjs"
import { ProviderModelTemplateDialog, ProviderModelTemplateConfirmation, type ProviderModelTemplateTarget } from "@/components/settings/provider-model-template-dialog"

const probeReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

type ProviderSettingsManagementProps = {
  management: ProviderSettingsController
  onChanged?: () => void
} & ({ section: "models"; renderCatalog: (groups: ModelCatalogGroup[]) => ReactNode } | { section: "providers"; renderCatalog?: never })

interface ModelContextDraft {
  provider: string
  model: string
  revision: string
  displayName: string
  previousContextWindow: number
  maxContextWindow: number
  value: string
  preset: ContextWindowPreset
}

export function ProviderSettingsManagement({ management, onChanged, section, renderCatalog }: ProviderSettingsManagementProps) {
  const { t } = useTranslation()
  const settings = management.settings
  if (settings === null) {
    const content = management.loading ? renderCatalog ? <p aria-busy="true">{t("common.loading")}</p> : <LoadingSettingsCard title={t("managementUi.providerSettings")} /> : <SettingsError message={management.error ?? t("managementUi.providerSettingsUnavailable")} retry={management.refetch} />
    return renderCatalog ? renderCatalog([{ id: "third-party-status", header: t("modelCatalog.title"), models: [], onSelect: () => {}, renderAction: () => null, content }]) : content
  }
  return <>{management.error !== null && !renderCatalog ? <SettingsError message={management.error} retry={management.refetch} /> : null}<ProviderSettingsCard settings={settings} management={management} onChanged={onChanged} section={section} renderCatalog={renderCatalog} /></>
}

function ProviderSettingsCard({
  settings,
  management,
  onChanged,
  section,
  renderCatalog,
}: {
  section: "providers" | "models"
  settings: ManagementProviderSettingsResponse
  management: ProviderSettingsController
  onChanged?: () => void
  renderCatalog?: (groups: ModelCatalogGroup[]) => ReactNode
}) {
  const { t } = useTranslation()
  const [editorOpen, setEditorOpen] = useState(false)
  const [selectedModel, setSelectedModel] = useState<{ provider: string; model: string; revision: string } | null>(null)
  const selectedCatalog = settings.modelCatalogs.find(catalog => catalog.provider === selectedModel?.provider)
  const detailsStale = selectedModel !== null && selectedCatalog?.revision !== selectedModel.revision
  const detailModel = !management.loading && management.error === null && !detailsStale
    ? selectedCatalog?.models.find(entry => entry.id === selectedModel?.model)?.presentation ?? null : null
  const [editorRevision, setEditorRevision] = useState<string | null>(null)
  const [originalModelCount, setOriginalModelCount] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [providerId, setProviderId] = useState("")
  const [providerName, setProviderName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [mode, setMode] = useState<"switching" | "exclusive">("switching")
  const [model, setModel] = useState("")
  const [catalogKind, setCatalogKind] = useState("official")
  const [customModels, setCustomModels] = useState<CustomModelDraft[]>([])
  const [supportsWebsockets, setSupportsWebsockets] = useState("true")
  const [upstreamWireApi, setUpstreamWireApi] = useState<"responses" | "chat_completions">("responses")
  const [upstreamTouched, setUpstreamTouched] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [confirmRemoveBaseUrl, setConfirmRemoveBaseUrl] = useState(false)
  const [managedProvider, setManagedProvider] = useState(settings.managedProviders[0]?.id ?? "")
  const [contextDraft, setContextDraft] = useState<ModelContextDraft | null>(null)
  const [templateTarget, setTemplateTarget] = useState<ProviderModelTemplateTarget | null>(null)
  const templateTriggerRef = useRef<HTMLButtonElement | null>(null)
  const contextPreviewRef = useRef<HTMLButtonElement | null>(null)
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const templatePreviewRef = useRef<HTMLButtonElement | null>(null)
  const templateSavedTarget = useRef<ProviderModelTemplateTarget | null>(null)
  useEffect(() => {
    if (templateSavedTarget.current === null || management.loading || management.busy || management.readbackRequired) return
    if (templateTriggerRef.current?.isConnected) {
      templateTriggerRef.current.focus()
      templateSavedTarget.current = null
    }
  }, [management.loading, management.busy, management.readbackRequired, settings])
  const contextCatalog = settings.modelCatalogs.find(catalog => catalog.provider === contextDraft?.provider)
  const contextStale = contextDraft !== null && (contextCatalog?.revision !== contextDraft.revision || contextCatalog.source === "official-shared")
  const contextValid = contextDraft !== null && validContextWindow(contextDraft.value, 1024, contextDraft.maxContextWindow)
  const modelsOnly = section === "models"
  const editorStale = editingId !== null && editorOpen && editorRevision !== settings.resourceRevision

  const managed = settings.managedProviders.find((provider) => provider.id === managedProvider) ?? settings.managedProviders[0]
  const [managedDraft, patchManaged, resetManaged] = useSettingsDraft({ model: managed?.model ?? "", reasoning: managed?.reasoningEffort ?? "" })
  const { model: managedModel, reasoning: managedReasoning } = managedDraft
  const managedModelEntry = managed?.models.find((candidate) => candidate.id === managedModel)
  const candidates = useMemo(() => [
    ...settings.customProviders.fixedCandidates,
    ...settings.customProviders.switchingProviders,
    ...settings.customProviders.backupCandidates,
  ], [settings.customProviders])
  const busy = management.busy || management.loading || management.error !== null || management.readbackRequired
  const pending = management.pendingPreview
  const probe = useCustomModelCapabilityProbe(JSON.stringify({ configVersion: settings.configVersion, editingId, providerId, providerName, baseUrl, apiKey, upstreamWireApi, customModels, mode, model, supportsWebsockets, confirmRemoveBaseUrl }), editorOpen && !editorStale && catalogKind === "custom" && pending === null)

  const managedId = managed?.id
  useEffect(() => { resetManaged() }, [managedId, resetManaged])

  const resetForm = () => {
    probe.invalidate()
    setEditorOpen(false)
    setEditorRevision(null)
    setOriginalModelCount(0)
    setEditingId(null)
    setProviderId("")
    setProviderName("")
    setBaseUrl("")
    setMode("switching")
    setModel("")
    setCatalogKind("official")
    setCustomModels([])
    setSupportsWebsockets("true")
    setUpstreamWireApi("responses")
    setUpstreamTouched(false)
    setApiKey("")
    setConfirmRemoveBaseUrl(false)
  }

  const edit = (candidate: typeof candidates[number]) => {
    setEditorRevision(settings.resourceRevision)
    setOriginalModelCount(candidate.models?.length ?? 0)
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
    setUpstreamWireApi("upstreamWireApi" in candidate && candidate.upstreamWireApi === "chat_completions" ? "chat_completions" : "responses")
    setUpstreamTouched(false)
    setApiKey("")
    setConfirmRemoveBaseUrl(false)
    management.clearError()
  }

  const saveCustom = async () => {
    if (editorStale) return
    if (editingId !== null && editorRevision === null) return
    if (modelsOnly && editingId !== null) {
      const models = customModels.map(({ probeConnection: _probeConnection, ...entry }) => {
        const descriptions = Object.fromEntries(Object.entries(entry.reasoningDescriptions ?? {}).filter(([effort]) => entry.reasoningEfforts.includes(effort)))
        return { ...entry, reasoningDescriptions: Object.keys(descriptions).length === 0 ? undefined : descriptions,
          ...(entry.template === undefined ? {} : { template: { source: entry.template.source, model: entry.template.model } }) }
      })
      const probeConnections = customModels.flatMap(entry => (["applyPatch", "toolSearch"] as const).flatMap(capability => {
        const token = entry.probeConnection?.[capability]
        return token === undefined ? [] : [{ model: entry.id, capability, token }]
      }))
      if (editorRevision === null) return
      await management.mutate({ operation: "model.custom.save", resourceRevision: editorRevision, provider: editingId, models, model: model.trim(), probeConnections })
      return
    }
    const credential = apiKey.trim() === ""
      ? { action: "preserve" as const }
      : { action: "replace" as const, apiKey }
    const result = await management.mutate({
      operation: "primary.custom.save",
      ...(editingId !== null && editorRevision !== null ? { resourceRevision: editorRevision } : {}),
      provider: {
        operation: editingId === null ? "create" : "update",
        providerId: providerId.trim(),
        name: providerName.trim(),
        baseUrl: baseUrl.trim(),
        mode,
        model: model.trim(),
        ...(catalogKind === "custom" ? {
          catalog: { kind: "custom" as const, models: customModels.map(({ probeConnection: _probeConnection, ...entry }) => {
            const descriptions = Object.fromEntries(Object.entries(entry.reasoningDescriptions ?? {}).filter(([effort]) => entry.reasoningEfforts.includes(effort)))
            return { ...entry, reasoningDescriptions: Object.keys(descriptions).length === 0 ? undefined : descriptions,
              ...(entry.template === undefined ? {} : { template: { source: entry.template.source, model: entry.template.model } }) }
          }) },
          probeConnections: customModels.flatMap(entry => (["applyPatch", "toolSearch"] as const).flatMap(capability => {
            const token = entry.probeConnection?.[capability]
            return token === undefined ? [] : [{ model: entry.id, capability, token }]
          })),
        } : {}),
        supportsWebsockets: supportsWebsockets === "true",
        ...(catalogKind === "custom" && (upstreamTouched || editingId === null || customModels.some(entry => entry.probeConnection !== undefined)) ? { upstreamWireApi } : {}),
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

  const updateContext = async () => {
    if (busy || pending !== null || contextDraft === null || contextStale || !contextValid || Number(contextDraft.value) === contextDraft.previousContextWindow) return
    await management.mutate({
      operation: "model.context",
      provider: contextDraft.provider,
      model: contextDraft.model,
      revision: contextDraft.revision,
      contextWindow: Number(contextDraft.value),
    })
  }



  const cancelPending = () => {
    management.cancel()
    setApiKey("")
  }

  const confirmPending = async () => {
    const operation = management.pendingPreview?.input.operation
    const result = await management.confirm()
    if (result !== null && (operation === "primary.custom.save" || operation === "model.custom.save")) resetForm()
    if (result !== null && operation === "managed.default") resetManaged()
    if (result !== null && operation === "model.context") setContextDraft(null)
    if (result !== null && operation === "model.template.update") {
      templateSavedTarget.current = templateTarget
      setTemplateTarget(null)
    }
    if (result !== null) onChanged?.()
  }

  const catalogGroups: ModelCatalogGroup[] = settings.modelCatalogs.map(catalog => {
    const custom = candidates.find(candidate => candidate.id === catalog.provider && candidate.catalog === "custom" && (("mode" in candidate && candidate.mode === "switching") || ("active" in candidate && candidate.active)))
    return {
      id: `provider:${catalog.provider}`,
      header: <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{catalog.displayName}</h3><Badge variant="outline">{t(catalog.source === "managed" ? "modelCatalog.sourceManaged" : catalog.source === "custom" ? "modelCatalog.sourceCustom" : "modelCatalog.sourceOfficial")}</Badge></div>
          <p className="text-xs font-normal text-muted-foreground">{t("modelCatalog.scope", { providers: catalog.providers.join(t("managementUi.listSeparator")) })}</p>
        </div>
        {custom && <Button variant="outline" size="sm" disabled={busy || pending !== null || contextDraft !== null || templateTarget !== null} onClick={() => edit(custom)}>{t("modelCatalog.editCustom")}</Button>}
      </div>,
      models: catalog.models.map(entry => ({ ...entry.presentation, isDefault: entry.isDefault })),
      onSelect: model => setSelectedModel({ provider: catalog.provider, model: model.model, revision: catalog.revision }),
      renderAction: model => {
        const reason = model.isDefault ? t("modelCatalog.defaultProtected") : catalog.models.length <= 1 ? t("modelCatalog.lastProtected") : !catalog.canRemove ? t("modelCatalog.unsupported") : undefined
        const locked = busy || pending !== null || contextDraft !== null || editorOpen || templateTarget !== null
        return <DropdownMenu onOpenChange={(open, details) => { if (open && locked) details.cancel() }}>
          <DropdownMenuTrigger ref={node => {
            const target = templateTarget ?? templateSavedTarget.current
            if (target?.provider === catalog.provider && target.model === model.model) templateTriggerRef.current = node
          }} render={<Button variant="outline" size="sm" />} onFocus={event => { actionTriggerRef.current = event.currentTarget }} onPointerDown={event => { actionTriggerRef.current = event.currentTarget }} aria-disabled={locked}>{t("modelManagement.actions")}</DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64" finalFocus={contextDraft !== null || templateTarget !== null || pending !== null ? false : undefined}><DropdownMenuGroup>
          <DropdownMenuItem disabled={locked || catalog.source === "official-shared" || model.contextWindow === null || model.maxContextWindow === null} onClick={() => {
            if (locked || model.contextWindow === null || model.maxContextWindow === null) return
            management.clearError()
            setContextDraft({ provider: catalog.provider, model: model.model, revision: catalog.revision, displayName: model.displayName, previousContextWindow: model.contextWindow, maxContextWindow: model.maxContextWindow, value: String(model.contextWindow), preset: contextWindowPreset(model.contextWindow, model.maxContextWindow) })
          }}>{t("openAiModelCatalog.adjustContext")}</DropdownMenuItem>
          {catalog.source !== "official-shared" ? <DropdownMenuItem disabled={locked} onClick={() => { if (locked) return; management.clearError(); setTemplateTarget({ provider: catalog.provider, model: model.model, revision: catalog.revision }) }}>{t("modelTemplate.title")}</DropdownMenuItem> : null}
          <DropdownMenuItem variant="destructive" className="flex-col items-start whitespace-normal" disabled={locked || reason !== undefined} onClick={() => { if (locked || reason !== undefined) return; void management.mutate({ operation: "model.remove", provider: catalog.provider, model: model.model }) }}><span>{t("modelCatalog.remove")}</span>{reason ? <span className="text-xs">{reason}</span> : null}</DropdownMenuItem>
          </DropdownMenuGroup></DropdownMenuContent>
        </DropdownMenu>
      },
      content: management.loading ? <p>{t("common.loading")}</p> : management.error !== null ? <SettingsError message={management.error} retry={management.refetch} /> : catalog.models.length === 0 ? <SettingsEmpty>{t("modelCatalog.empty")}</SettingsEmpty> : undefined,
      footer: !catalog.canRemove ? <p className="text-muted-foreground">{catalog.unavailableReason === "deepseek-template-source" ? t("modelCatalog.deepseek") : catalog.unavailableReason === "shared-accounts-incomplete" ? t("modelCatalog.accountsIncomplete") : catalog.unavailableReason === "official-catalog-unavailable" ? t("modelCatalog.officialUnavailable") : catalog.unavailableReason === "official-shared-catalog" ? t("modelCatalog.official") : t("modelCatalog.unsupported")}</p> : undefined,
    }
  })
  if (catalogGroups.length === 0) catalogGroups.push({
    id: "third-party-status", header: t("modelCatalog.title"), models: [], onSelect: () => {}, renderAction: () => null,
    content: management.loading ? <p>{t("common.loading")}</p> : management.error !== null ? <SettingsError message={management.error} retry={management.refetch} /> : <SettingsEmpty>{t("modelCatalog.empty")}</SettingsEmpty>,
  })

  const feedback = <>
    {management.actionError !== null && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
    <SettingsMutationFeedback result={management.actionResult} writeUnconfirmed={management.writeUnconfirmed} readbackRequired={management.readbackRequired} />
  </>

  return <>{section === "models" && <>{renderCatalog?.(catalogGroups)}{feedback}</>}<Card>
    <CardHeader>
      <CardTitle>{section === "providers" ? t("managementUi.customProviders") : t("managementUi.managedDefaults")}</CardTitle>
      <CardDescription>{section === "providers" ? t("managementUi.customProvidersHint") : t("managementUi.managedDefaultsDetail")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-6 text-sm">
      {section === "models" && <Alert><AlertDescription>{t("modelCatalog.cliManaged")} <code>codexc setup</code></AlertDescription></Alert>}
      {section === "models" && <section className="flex flex-col gap-3">
        {managed === undefined ? <SettingsEmpty>{t("managementUi.managedProvidersEmpty")}</SettingsEmpty> : <>
          <FieldGroup>
            <ManagedSelect label={t("managementUi.provider")} value={managed.id} options={settings.managedProviders.map((provider) => [provider.id, provider.displayName])} disabled={busy || pending !== null} onChange={setManagedProvider} />
            <ManagedSelect label={t("managementUi.defaultModel")} value={managedModel} options={managed.models.map((candidate) => [candidate.id, formatModelLabel(candidate.id, candidate.displayName)])} disabled={busy || pending !== null} onChange={(value) => patchManaged({ model: value })} />
            <ManagedSelect label={t("managementUi.reasoning")} value={managedReasoning} options={(managedModelEntry?.reasoningEfforts ?? []).map((candidate) => [candidate.effort, candidate.effort])} disabled={busy || pending !== null} onChange={(value) => patchManaged({ reasoning: value })} />
          </FieldGroup>
          <Button className="self-start" variant="outline" size="sm" disabled={busy || pending !== null || managedModelEntry === undefined} onClick={() => void updateManagedDefault()}>{t("managementUi.saveManagedDefaults")}</Button>
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
      </section>}
      {(section === "providers" || modelsOnly) && <Dialog open={editorOpen} onOpenChange={open => { if (!open && !management.busy && pending === null) resetForm() }}><DialogContent closeLabel={t("common.close")} showCloseButton={!management.busy && pending === null} className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{modelsOnly ? t("modelCatalog.editCustom") : editingId === null ? t("managementUi.addProvider") : t("managementUi.editProvider")}</DialogTitle><DialogDescription>{t(modelsOnly ? "modelCatalog.customHint" : "managementUi.providerEditorHint")}</DialogDescription></DialogHeader>
        {!modelsOnly && <>
        <ManagedSelect label={t("managementUi.providerType")} value={catalogKind} options={[["official", t("managementUi.compatibleProvider")], ["custom", t("managementUi.responsesProvider")]]} disabled={busy || pending !== null || editingId !== null} onChange={(value) => { setCatalogKind(value); setProviderId(value === "custom" ? "cp-" : ""); setModel(""); setCustomModels([]) }} />
        <FieldGroup className="grid gap-3 md:grid-cols-2">
          <Field data-disabled={busy || pending !== null || editingId !== null}><FieldLabel htmlFor="custom-provider-id">{catalogKind === "custom" ? t("managementUi.responsesProviderId") : t("managementUi.providerId")}</FieldLabel><Input id="custom-provider-id" placeholder={t("managementUi.providerIdExample")} value={providerId} disabled={busy || pending !== null || editingId !== null} onChange={(event) => setProviderId(event.target.value)} /></Field>
          <Field data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-name">{t("managementUi.displayName")}</FieldLabel><Input id="custom-provider-name" placeholder={t("managementUi.displayName")} value={providerName} disabled={busy || pending !== null} onChange={(event) => setProviderName(event.target.value)} /></Field>
          <Field className="md:col-span-2" data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-endpoint">{t("managementUi.responsesBaseUrl")}</FieldLabel><Input id="custom-provider-endpoint" placeholder="https://example.com/v1" value={baseUrl} disabled={busy || pending !== null} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
          <Field data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-model">{catalogKind === "custom" ? t("managementUi.defaultModelId") : t("managementUi.officialModelId")}</FieldLabel><Input id="custom-provider-model" placeholder={t("managementUi.modelId")} value={model} disabled={busy || pending !== null} onChange={(event) => setModel(event.target.value)} /></Field>
          <ManagedSelect label={t("modelManagement.mode")} value={mode} options={[["switching", t("modelManagement.switching")], ["exclusive", t("modelManagement.exclusive")]]} disabled={busy || pending !== null} onChange={(value) => setMode(value as "switching" | "exclusive")} />
          {catalogKind === "custom" ? <ManagedSelect label={t("managementUi.upstreamInterface")} value={upstreamWireApi} options={[["responses", t("managementUi.upstreamResponses")], ["chat_completions", t("managementUi.upstreamChatCompletions")]]} disabled={busy || pending !== null} onChange={(value) => { const next = value === "chat_completions" ? "chat_completions" : "responses"; setUpstreamWireApi(next); setUpstreamTouched(true); if (next === "chat_completions") setSupportsWebsockets("false") }} /> : null}
          <ManagedSelect label="WebSocket" value={supportsWebsockets} options={[["true", t("managementUi.supported")], ["false", t("managementUi.unsupported")]]} disabled={busy || pending !== null || upstreamWireApi === "chat_completions"} onChange={setSupportsWebsockets} />
          <Field className="md:col-span-2" data-disabled={busy || pending !== null}><FieldLabel htmlFor="custom-provider-api-key">API Key</FieldLabel><Input id="custom-provider-api-key" type="password" autoComplete="new-password" placeholder={t("managementUi.preserveCredentials")} value={apiKey} disabled={busy || pending !== null} onChange={(event) => setApiKey(event.target.value)} /></Field>
        </FieldGroup></>}
        {modelsOnly && <FieldGroup><ManagedSelect label={t("managementUi.defaultModelId")} value={model} options={customModels.map(entry => [entry.id, formatModelLabel(entry.id, entry.name)])} disabled={busy || pending !== null} onChange={setModel} /></FieldGroup>}
        {catalogKind === "custom" ? <div className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{t("managementUi.responsesHint")}</p>
          {editingId !== null ? <p className="text-xs text-muted-foreground">{t("modelCatalog.editRequiresRemoval")}</p> : null}
          <Alert><AlertTitle>{t("modelProbe.title")}</AlertTitle><AlertDescription>{t("modelProbe.hint")}</AlertDescription></Alert>
          {customModels.map((entry, index) => {
            const existingModel = editingId !== null && index < originalModelCount
            const patch = (changes: Partial<typeof entry>) => setCustomModels(current => current.map((value, position) => position === index ? { ...value, ...changes } : value))
            const reasoningEffort = probeReasoningEfforts.find(effort => effort === (entry.defaultReasoningEffort ?? "none"))
            return <FieldGroup key={index} className="rounded-md border p-3">
              <Field><FieldLabel htmlFor={`responses-model-${index}`}>{t("managementUi.modelId")}</FieldLabel><Input id={`responses-model-${index}`} value={entry.id} disabled={busy || pending !== null || existingModel} onChange={event => patch({ id: event.target.value })} /></Field>
              <Field><FieldLabel htmlFor={`responses-name-${index}`}>{t("managementUi.displayName")}</FieldLabel><Input id={`responses-name-${index}`} value={entry.name} disabled={busy || pending !== null} onChange={event => patch({ name: event.target.value })} /></Field>
              <ManagedSelect label={t("managementUi.contextPreset")} value={entry.contextWindow ? String(entry.contextWindow) : ""} options={contextWindowPresetTokens.filter(value => value <= (entry.maxContextWindow ?? 100000000)).map(value => [String(value), t("managementUi.contextPresetLabel", { k: value / 1024, tokens: value })])} disabled={busy || pending !== null} onChange={value => patch({ contextWindow: Number(value) })} />
              <Field><FieldLabel htmlFor={`responses-context-${index}`}>{t("managementUi.contextTokens")}</FieldLabel><Input id={`responses-context-${index}`} type="number" min={1024} max={entry.maxContextWindow ?? 100000000} value={entry.contextWindow || ""} disabled={busy || pending !== null} onChange={event => patch({ contextWindow: Number(event.target.value) })} /></Field>
              <Field orientation="horizontal"><Checkbox id={`responses-reasoning-supported-${index}`} checked={entry.reasoningEfforts.length > 0} disabled={busy || pending !== null} onCheckedChange={value => patch({ reasoningEfforts: value === true ? ["medium"] : [], defaultReasoningEffort: value === true ? "medium" : null, reasoningDescriptions: undefined })} /><FieldLabel htmlFor={`responses-reasoning-supported-${index}`}>{t("managementUi.supportsReasoning")}</FieldLabel></Field>
              {entry.reasoningEfforts.length > 0 ? <Field><FieldLabel htmlFor={`responses-reasoning-${index}`}>{t("managementUi.reasoningList")}</FieldLabel><Input id={`responses-reasoning-${index}`} value={entry.reasoningEfforts.join(",")} placeholder="low,medium,high" disabled={busy || pending !== null} onChange={event => { const values = event.target.value === "" ? [] : event.target.value.split(","); patch({ reasoningEfforts: values, defaultReasoningEffort: values.includes(entry.defaultReasoningEffort ?? "") ? entry.defaultReasoningEffort : values[0] ?? null }) }} /></Field> : null}
              {entry.reasoningEfforts.length > 0 ? <Field><FieldLabel htmlFor={`responses-default-${index}`}>{t("managementUi.defaultReasoning")}</FieldLabel><Input id={`responses-default-${index}`} value={entry.defaultReasoningEffort ?? ""} disabled={busy || pending !== null} onChange={event => patch({ defaultReasoningEffort: event.target.value })} /></Field> : null}
              <Field orientation="horizontal"><Checkbox id={`responses-images-${index}`} checked={entry.supportsImages} disabled={busy || pending !== null} onCheckedChange={value => patch({ supportsImages: value === true, supportsImageDetailOriginal: value === true ? entry.supportsImageDetailOriginal : false })} /><FieldLabel htmlFor={`responses-images-${index}`}>{t("managementUi.imageInput")}</FieldLabel></Field>
              <CustomModelDetails entry={entry} index={index} disabled={busy || pending !== null} upstreamWireApi={upstreamWireApi} patch={patch} />
              <Field orientation="horizontal"><Checkbox id={`responses-patch-${index}`} checked={entry.applyPatchToolType === "freeform"} disabled={busy || pending !== null} onCheckedChange={value => patch({ applyPatchToolType: value === true ? "freeform" : undefined, probeConnection: { ...entry.probeConnection, applyPatch: undefined } })} /><FieldLabel htmlFor={`responses-patch-${index}`}>{t("managementUi.freeformPatchTool")}</FieldLabel></Field>
              <Field orientation="horizontal"><Checkbox id={`responses-search-${index}`} checked={entry.supportsSearchTool === true} disabled={busy || pending !== null} onCheckedChange={value => patch({ supportsSearchTool: value === true, probeConnection: { ...entry.probeConnection, toolSearch: undefined } })} /><FieldLabel htmlFor={`responses-search-${index}`}>{t("managementUi.toolSearchTool")}</FieldLabel></Field>
              <p className="text-muted-foreground">{reasoningEffort === undefined ? t("modelProbe.invalidReasoning") : t("modelProbe.reasoningEffort", { effort: reasoningEffort })}</p>
              <div className="flex flex-wrap gap-2">
                {(["applyPatch", "toolSearch"] as const).map(capability => <Button key={capability} variant="outline" disabled={busy || pending !== null || probe.running || reasoningEffort === undefined || !entry.id.trim() || !baseUrl.trim() || (editingId === null && !apiKey.trim())} onClick={() => { if (reasoningEffort === undefined) return; void probe.start(index, {
                  ...(editingId === null ? {} : { providerId: editingId }), baseUrl: baseUrl.trim(), model: entry.id.trim(), upstreamWireApi,
                  capability, reasoningEffort,
                  credential: apiKey.trim() === "" ? { action: "preserve" } : { action: "replace", apiKey },
                }) }}>{probe.running && probe.state?.index === index && probe.state.capability === capability ? t("modelProbe.running") : t("modelProbe.detectTool", { tool: t(`modelProbe.capabilities.${capability}`) })}</Button>)}
                {probe.state?.index === index && probe.running ? <Button variant="outline" onClick={probe.cancel}>{t("modelProbe.cancel")}</Button> : null}
                {probe.state?.index === index && probe.state.result ? <Button variant="outline" disabled={busy || pending !== null || !probe.canApply} onClick={() => {
                  const result = probe.state?.result
                  if (!probe.canApply || !result || result.model !== entry.id.trim()) return
                  patch({ ...(result.capability === "applyPatch"
                    ? { applyPatchToolType: result.check.status === "supported" ? "freeform" : undefined }
                    : { supportsSearchTool: result.check.status === "supported" }), probeConnection: { ...entry.probeConnection, [result.capability]: result.connectionToken } })
                }}>{t("modelProbe.applyTool", { tool: t(`modelProbe.capabilities.${probe.state.result.capability}`) })}</Button> : null}
              </div>
              {probe.state?.index === index ? <div className="flex flex-col gap-2" role="status" aria-live="polite">
                {probe.state.errorCode ? <Alert variant="destructive"><AlertDescription>{translateApiErrorCode(t, probe.state.errorCode)}</AlertDescription></Alert> : null}
                {probe.state.cancelled || probe.state.result?.status === "cancelled" ? <p>{t("modelProbe.cancelled")}</p> : null}
                {probe.state.result ? <>
                  <p className="text-muted-foreground">{t("modelProbe.resultHint")}</p>
                  <Table><TableHeader><TableRow><TableHead>{t("modelProbe.capability")}</TableHead><TableHead>{t("modelProbe.status")}</TableHead><TableHead>{t("modelProbe.evidence")}</TableHead></TableRow></TableHeader><TableBody>{[probe.state.result.check].map(check => <TableRow key={check.capability}><TableCell>{t(`modelProbe.capabilities.${check.capability}`)}</TableCell><TableCell><Badge variant={check.status === "supported" ? "secondary" : "outline"}>{t(`modelProbe.statuses.${check.status}`)}</Badge></TableCell><TableCell><p>{translateCustomModelProbeReason(t, check.reason)}</p>{check.httpStatus === undefined ? t("modelProbe.noHttpStatus") : t("modelProbe.httpStatus", { status: check.httpStatus })}</TableCell></TableRow>)}</TableBody></Table>
                  {!probe.canApply ? <p className="text-muted-foreground">{t("modelProbe.cannotApply")}</p> : null}
                </> : null}
              </div> : null}
              {!existingModel ? <Button variant="outline" disabled={busy || pending !== null} onClick={() => setCustomModels(current => current.filter((_, position) => position !== index))}>{t("managementUi.removeModel")}</Button> : null}
            </FieldGroup>
          })}
          <Button variant="outline" disabled={busy || pending !== null || customModels.length >= 64} onClick={() => setCustomModels(current => [...current, { id: current.length === 0 ? model : "", name: current.length === 0 ? model : "", contextWindow: 0, reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: false }])}>{t("managementUi.addModel")}</Button>
        </div> : null}
        {!modelsOnly && mode === "exclusive" ? <Field orientation="horizontal" data-disabled={busy || pending !== null}><Checkbox id="custom-provider-remove-base-url" checked={confirmRemoveBaseUrl} disabled={busy || pending !== null} onCheckedChange={(checked) => setConfirmRemoveBaseUrl(checked === true)} /><FieldLabel htmlFor="custom-provider-remove-base-url" className="text-xs text-muted-foreground">{t("managementUi.removeBaseUrl")}</FieldLabel></Field> : null}
        {editorStale ? <Alert variant="destructive"><AlertDescription>{t("modelCatalog.stale")}</AlertDescription></Alert> : null}
        <div className="flex flex-wrap gap-2"><Button disabled={busy || pending !== null || probe.running || editorStale || providerId.trim() === "" || providerName.trim() === "" || baseUrl.trim() === "" || model.trim() === "" || (editingId === null && apiKey.trim() === "")} onClick={() => void saveCustom()}>{modelsOnly ? t("modelCatalog.saveCustom") : editingId === null ? t("managementUi.addProvider") : t("managementUi.saveProvider")}</Button>{editingId !== null ? <Button variant="outline" disabled={busy || pending !== null} onClick={resetForm}>{t("managementUi.cancelEditing")}</Button> : null}</div>
        {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
        </DialogContent></Dialog>}
      {pending !== null ? <ProviderSettingsConfirmationDialog pending={pending.preview} saving={management.busy} loading={management.loading} finalFocus={() => {
        const preview = pending.preview.operation === "model.template.update" ? templatePreviewRef.current : pending.preview.operation === "model.context" ? contextPreviewRef.current : null
        if (!["model.template.update", "model.context", "model.remove"].includes(pending.preview.operation)) return true
        return preview === null ? (pending.preview.operation === "model.template.update" ? templateTriggerRef.current : actionTriggerRef.current) ?? true : preview.disabled ? false : preview
      }} onConfirm={() => void confirmPending()} onCancel={cancelPending} /> : null}
      {section !== "models" && feedback}
    </CardContent>
  </Card>
    <Dialog open={contextDraft !== null && pending === null} disablePointerDismissal onOpenChange={(open, details) => { if (management.busy) { details.cancel(); return }; if (!open) setContextDraft(null) }}>
      <DialogContent finalFocus={pending === null ? actionTriggerRef : false} closeLabel={t("modelManagement.cancel")} showCloseButton={!management.busy} className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("modelCatalog.editContext")}</DialogTitle><DialogDescription>{t("modelCatalog.editContextHint")}</DialogDescription></DialogHeader>
        {contextDraft && <div className="flex flex-col gap-6">
          <code className="break-all text-xs text-muted-foreground">{contextDraft.provider} · {contextDraft.model}</code>
          <ModelContextWindowFields displayName={contextDraft.displayName} maxContextWindow={contextDraft.maxContextWindow} value={contextDraft.value} preset={contextDraft.preset} valid={contextValid} minimum={1024} disabled={busy || contextStale} onValueChange={value => setContextDraft(current => current === null ? null : { ...current, value })} onPresetChange={preset => setContextDraft(current => {
            if (current === null || busy || contextStale) return current
            const value = preset === "custom" ? current.value : String(preset === "max" ? current.maxContextWindow : Number(preset))
            return { ...current, preset, value }
          })} />
          {contextStale && <Alert variant="destructive"><AlertDescription>{t("modelCatalog.stale")}</AlertDescription></Alert>}
          {management.error && <Alert variant="destructive"><AlertDescription>{management.error}</AlertDescription></Alert>}
          {management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
        </div>}
        <DialogFooter><Button variant="outline" disabled={management.busy} onClick={() => setContextDraft(null)}>{t("modelManagement.cancel")}</Button><Button ref={contextPreviewRef} disabled={busy || contextStale || !contextValid || contextDraft?.value === String(contextDraft?.previousContextWindow)} onClick={() => void updateContext()}>{t("modelManagement.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {templateTarget !== null ? <ProviderModelTemplateDialog key={`${templateTarget.provider}:${templateTarget.model}:${templateTarget.revision}`} target={templateTarget} open={pending === null} stale={settings.modelCatalogs.find(catalog => catalog.provider === templateTarget.provider)?.revision !== templateTarget.revision} management={management} previewRef={templatePreviewRef} finalFocus={templateTriggerRef} onClose={() => setTemplateTarget(null)} /> : null}
    {section === "models" && <OpenAiModelDetails model={detailModel} revision={selectedModel?.revision ?? null} provider={selectedModel?.provider} stale={detailsStale} open={selectedModel !== null} loading={management.loading} onClose={() => setSelectedModel(null)} onReload={() => { setSelectedModel(null); management.refetch() }} />}
  </>
}

function ProviderSettingsConfirmationDialog({
  pending,
  saving,
  loading,
  finalFocus,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<ProviderSettingsController["pendingPreview"]>["preview"]
  saving: boolean
  loading?: boolean
  finalFocus?: ComponentProps<typeof ProviderModelTemplateConfirmation>["finalFocus"]
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  if (pending.operation === "model.template.update") return <ProviderModelTemplateConfirmation preview={pending} saving={saving} loading={loading} finalFocus={finalFocus} onConfirm={onConfirm} onCancel={onCancel} />
  const localRemoval = pending.operation === "model.remove"
  const providerDetails = typeof pending.provider === "object" ? pending.provider : undefined
  const notices: string[] = []
  const contextChange = pending.operation === "model.context"
  const lines = localRemoval ? [] : [pending.operation === "model.custom.save" ? t("modelCatalog.editOperation") : contextChange ? t("modelCatalog.contextOperation") : t("accountConfirmation.operation", { value: pending.operation })]
  if (!localRemoval && pending.provider !== undefined) lines.push(t("managementUi.providerConfirm", { name: typeof pending.provider === "string" ? pending.provider : pending.provider.displayName ?? pending.provider.name ?? pending.provider.id }))
  if (providerDetails?.model !== undefined) lines.push(t("managementUi.defaultModelConfirm", { value: providerDetails.model }))
  if (providerDetails !== undefined && "upstreamWireApi" in providerDetails) lines.push(t("managementUi.upstreamConfirm", { value: providerDetails.upstreamWireApi === "chat_completions" ? t("managementUi.upstreamChatCompletions") : t("managementUi.upstreamResponses") }))
  if (providerDetails?.models !== undefined) for (const model of providerDetails.models) lines.push(t("managementUi.modelSummary", { name: model.name, id: model.id, context: model.contextWindow, images: t(model.supportsImages ? "managementUi.supported" : "managementUi.unsupported"), reasoning: model.reasoningEfforts.join("/") || t("managementUi.unsupported"), default: model.defaultReasoningEffort ?? "none", patch: model.applyPatchToolType ?? t("managementUi.unsupported"), search: t(model.supportsSearchTool ? "managementUi.supported" : "managementUi.unsupported") }) + (model.template ? t("managementUi.templateSummary", { source: model.template.source, model: model.template.model }) : ""))
  if (pending.target !== undefined) lines.push(t("managementUi.targetConfirm", { name: pending.target.displayName, id: pending.target.id }))
  if (!localRemoval && pending.model !== undefined) lines.push(t("managementUi.modelConfirm", { name: pending.model.displayName, id: pending.model.id }))
  if (contextChange && pending.model?.contextWindow !== undefined) lines.push(t("openAiModelCatalog.previousContext") + ": " + pending.model.contextWindow)
  if (contextChange && pending.model?.maxContextWindow !== undefined) lines.push(t("openAiModelCatalog.maxContext") + ": " + pending.model.maxContextWindow)
  if (pending.providers !== undefined && pending.providers.length > 0) lines.push(t(localRemoval ? "modelCatalog.removalScope" : "managementUi.appliedProviders", { providers: pending.providers.join(t("managementUi.listSeparator")) }))
  if (pending.reasoningEffort !== undefined) lines.push(t("managementUi.reasoningConfirm", { value: pending.reasoningEffort }))
  if (pending.contextWindow !== undefined) lines.push(t("managementUi.windowTokensConfirm", { tokens: pending.contextWindow }))
  else if (pending.windowPercent !== undefined) lines.push(t("managementUi.windowConfirm", { percent: pending.windowPercent }))
  if (pending.credential?.action !== undefined) lines.push(t("managementUi.credentialConfirm", { action: t(pending.credential.action === "replace" ? "managementUi.replaceCredential" : "managementUi.preserveCredential") }))
  if (pending.transport?.cleartext === true) lines.push(t("managementUi.cleartextUpstream"))
  const warningKeys: Record<string, MessageKey> = {
    "shared-relay-grants-retained": "modelCatalog.grants",
    "clp-relay-independent": "modelCatalog.independent",
    "historical-references": "modelCatalog.historical",
    "provider-relay-inflight": "modelCatalog.inflight",
  }
  const unknownWarning = pending.warnings?.some(warning => !Object.hasOwn(warningKeys, warning.code)) === true
  for (const warning of pending.warnings ?? []) {
    const known = Object.hasOwn(warningKeys, warning.code)
    const target = localRemoval ? notices : lines
    target.push(known ? t(warningKeys[warning.code]!) : t("modelCatalog.unknownWarning", { code: warning.code }))
  }
  if (localRemoval) notices.push(t("modelCatalog.backup"))
  return <ManagementConfirmationDialog finalFocus={finalFocus} open saving={saving} loading={loading} title={t(localRemoval ? "modelCatalog.confirmTitle" : contextChange ? "modelCatalog.confirmContextTitle" : "managementUi.providerConfirmTitle")} description={t(localRemoval ? "modelCatalog.removeOperation" : contextChange ? "modelCatalog.editContextHint" : "accountConfirmation.changeDescription")} confirmDisabled={unknownWarning} confirmVariant={pending.operation === "remove" || localRemoval ? "destructive" : "default"} onConfirm={onConfirm} onCancel={onCancel}>
    {localRemoval ? <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {pending.model !== undefined ? <div>
          <p className="font-medium break-words">{pending.model.displayName}</p>
          <p className="text-sm text-muted-foreground break-all">{pending.model.id}</p>
        </div> : null}
        <p className="text-sm whitespace-pre-line break-words">{lines.join("\n")}</p>
      </div>
      <Separator />
      <div className="flex flex-col gap-2 text-sm text-muted-foreground">
        {notices.map((notice, index) => <p key={index}>{notice}</p>)}
      </div>
    </div> : <p className="whitespace-pre-line">{lines.join("\n")}</p>}
    {providerDetails?.models?.map(entry => <CustomModelDetailsPreview key={entry.id} entry={entry} />)}
    {!localRemoval ? <p className="text-muted-foreground">{t("accountConfirmation.activation", { value: contextChange && pending.activation === "restart-app-server" ? t("settingsUi.restartAppServer") : pending.activation })}</p> : null}
    {contextChange && pending.activation === "restart-app-server" ? <p className="text-muted-foreground">{t("settingsUi.command", { value: "codexc restart appserver" })}</p> : null}
    {!localRemoval && pending.activation === "restart-all" ? <p className="text-muted-foreground">{t("settingsUi.command", { value: "codexc restart all" })}</p> : null}
  </ManagementConfirmationDialog>
}
