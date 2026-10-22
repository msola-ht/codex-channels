import { useTranslation } from "@/hooks/use-translation"
import { acceleratedServiceTierId, normalizeServiceTier } from "../../../../runtime/service-tier.mjs"
import { contextWindowPresetLabel, contextWindowPresetTokens } from "../../../../runtime/model-catalog.mjs"
import { useEffect, useState, type ReactNode } from "react"
import { cn } from "cn"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ManagedSelect, PendingSettingDialog, SettingsRow, SettingsMutationFeedback, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { CodexSettingsController } from "@/lib/settings-management"
import type { MessageKey } from "@/lib/i18n/messages"
import { ToolAccessSettings } from "@/components/settings/tool-access-settings"

const compactPercentPresets = [50, 60, 70, 80, 90] as const
const compactTokens = (window: number, percent: number) => String(BigInt(window) * BigInt(percent) / 100n)

export function AppServerSettingsCard({ management, onChanged, onEditingChange, section = "general", renderContent }: { management: CodexSettingsController; onChanged?: () => void; onEditingChange?: (editing: boolean) => void; section?: "general" | "permissions" | "models" | "context"; renderContent?: (content: ReactNode) => ReactNode }) {
  const { t } = useTranslation()
  const settings = management.codexSettings
  const selectedModel = settings?.models.find((model) => settings.defaults.model === null ? model.isDefault : model.model === settings.defaults.model)
  const [defaultDraft, patchDefaults, resetDefaults] = useSettingsDraft({ model: settings?.defaults.model ?? "", reasoning: settings?.defaults.reasoningEffort ?? "" })
  const [tierDraft, patchTier, resetTier] = useSettingsDraft({ tier: settings?.defaults.serviceTier == null ? "" : normalizeServiceTier(settings.defaults.serviceTier) })
  const compactSource = { contextWindow: settings?.compact.contextWindow == null ? "" : String(settings.compact.contextWindow), autoCompactTokenLimit: settings?.compact.autoCompactTokenLimit == null ? "" : String(settings.compact.autoCompactTokenLimit) }
  const [compact, patchCompact, resetCompact] = useSettingsDraft(compactSource)
  const { contextWindow, autoCompactTokenLimit } = compact
  const [customWindow, setCustomWindow] = useState(false)
  const [compactChoice, setCompactChoice] = useState<{ preset: string; window: string; threshold: string } | null>(null)
  const compactWindow = Number(contextWindow)
  const canUseCompactPercent = Number.isSafeInteger(compactWindow) && compactWindow > 1
  const matchingCompactPercents = canUseCompactPercent ? compactPercentPresets.filter(percent => compactTokens(compactWindow, percent) === autoCompactTokenLimit) : []
  const compactPreset = compactChoice?.window === contextWindow && compactChoice.threshold === autoCompactTokenLimit
    ? compactChoice.preset
    : autoCompactTokenLimit === "" ? "default" : matchingCompactPercents.length === 1 ? String(matchingCompactPercents[0]) : "custom"
  const windowPreset = customWindow ? "custom" : contextWindow === "" ? "default" : contextWindowPresetTokens.some(tokens => String(tokens) === contextWindow) ? contextWindow : "custom"
  const [compactError, setCompactError] = useState<{ field: "contextWindow" | "autoCompactTokenLimit"; value: string; message: MessageKey } | null>(null)
  const visibleCompactError = compactError !== null
    && compactError.value === compact[compactError.field]
      ? compactError : null
  const compactEditing = section === "context"
    && (contextWindow !== compactSource.contextWindow || autoCompactTokenLimit !== compactSource.autoCompactTokenLimit)
  useEffect(() => {
    onEditingChange?.(compactEditing)
    return () => onEditingChange?.(false)
  }, [compactEditing, onEditingChange])
  useEffect(() => {
    if (management.lastAppliedSetting?.kind === "model-compact") { resetCompact(); setCustomWindow(false); setCompactChoice(null) }
    if (management.lastAppliedSetting?.kind === "defaults") resetDefaults()
    if (management.lastAppliedSetting?.kind === "service-tier") resetTier()
  }, [management.lastAppliedSetting, resetCompact, resetDefaults, resetTier])

  if (management.loading && settings === null) return <LoadingSettingsCard title={t("settingsFields.appServerTitle")} />
  if (settings === null) return <SettingsError title={t("settingsUi.codexLoadFailed")} message={management.error ?? t("settingsFields.appServerUnavailable")} retry={management.refetch} />

  const confirmSetting = async () => {
    if (await management.confirmSetting()) onChanged?.()
  }
  const selected = selectedModel
  const draftModel = settings.models.find(model => model.model === defaultDraft.model)
  const draftEfforts = draftModel?.reasoningEfforts.map(item => [item.effort, item.effort]) ?? []
  const draftEffortValid = draftEfforts.some(([effort]) => effort === defaultDraft.reasoning)
  const unavailableModel = selected === undefined ? settings.defaults.model : null
  const modelOptions = settings.models.map((model) => [model.model, model.displayName])
  if (unavailableModel !== null) modelOptions.unshift([unavailableModel, t("settingsFields.modelUnavailable", { model: unavailableModel })])
  const effortOptions = selected?.reasoningEfforts.map((item) => [item.effort, item.effort]) ?? []
  const preferenceOptions = (field: string, options: string[][]) => [
    ...(settings.defaults.unsupportedFields.includes(field) ? [["unsupported", t("globalSettings.unsupportedValue")]] : []),
    ["inherit", t("settingsFields.inheritUserSetting")], ...options,
  ]
  const preferenceValue = (field: string, value: string | boolean | null | undefined) => settings.defaults.unsupportedFields.includes(field) ? "unsupported" : value == null ? "inherit" : String(value)
  const unsetLabel = (field: string) => t(settings.defaults.unsupportedFields.includes(field) ? "globalSettings.unsupportedValue" : "settingsFields.notSet")
  const busy = management.loading || management.error !== null || management.saving || management.pendingSetting !== null || management.readbackRequired
  const officialDisabled = busy || !(section === "context" ? settings.contextEditable : settings.defaultsEditable)
  const serviceTier = tierDraft.tier
  const serviceTierOptions = [["default", t("settingsFields.standard")]]
  if (settings.defaults.fastEnabled && selected && acceleratedServiceTierId(selected.serviceTiers, "fast")) serviceTierOptions.push(["fast", t("settingsFields.fast")])
  if (settings.defaults.ultrafastEnabled && selected && acceleratedServiceTierId(selected.serviceTiers, "ultrafast")) serviceTierOptions.push(["ultrafast", t("settingsFields.ultrafast")])
  const serviceTierUnavailable = serviceTier !== "" && !serviceTierOptions.some(([value]) => value === serviceTier)
  if (serviceTierUnavailable) serviceTierOptions.push([serviceTier, t("settingsFields.serviceTierUnavailable", { tier: serviceTier === "fast" ? t("settingsFields.fast") : serviceTier === "ultrafast" ? t("settingsFields.ultrafast") : serviceTier })])
  const reviewerHint: MessageKey = settings.approvalsReviewer?.editable
    ? "settingsFields.autoReviewHint"
    : settings.approvalsReviewer?.reason === "managed-policy"
      ? "settingsFields.autoReviewManaged"
      : settings.approvalsReviewer?.reason === "unsupported-value"
        ? "settingsFields.autoReviewUnsupported"
        : "settingsFields.autoReviewUnavailable"

  const saveCompact = () => {
    const parsedWindow = contextWindow.trim() === "" ? null : Number(contextWindow)
    const parsedTokenLimit = autoCompactTokenLimit.trim() === "" ? null : Number(autoCompactTokenLimit)
    if (parsedWindow !== null && (!Number.isSafeInteger(parsedWindow) || parsedWindow <= 0)) {
      setCompactError({ field: "contextWindow", value: contextWindow, message: "settingsFields.contextWindowInvalid" })
      return
    }
    if (parsedTokenLimit !== null && (!Number.isSafeInteger(parsedTokenLimit) || parsedTokenLimit <= 0)) {
      setCompactError({ field: "autoCompactTokenLimit", value: autoCompactTokenLimit, message: "settingsFields.compactTokenLimitInvalid" })
      return
    }
    setCompactError(null)
    void management.previewSetting({ kind: "model-compact", contextWindow: parsedWindow, autoCompactTokenLimit: parsedTokenLimit }, { key: "settingsFields.contextCompaction" })
  }

  const feedback = <SettingsMutationFeedback result={management.actionResult} writeUnconfirmed={management.writeUnconfirmed} readbackRequired={management.readbackRequired} />
  const content = <div className="flex min-w-0 flex-col gap-5 text-sm">
      {renderContent && feedback}
      {management.error !== null ? <SettingsError title={t("settingsUi.codexLoadFailed")} message={`${management.error} ${t("settingsUi.previousSnapshot")}`} retry={management.refetch} /> : null}
      {settings.defaults.unsupportedFields.length > 0 && <Alert><AlertDescription>{t("globalSettings.unsupported")}</AlertDescription></Alert>}
      {!settings.modelsAvailable && settings.provider === "openai" && <Alert><AlertDescription>{t("globalSettings.modelsUnavailable")}</AlertDescription></Alert>}
      {section === "models" && !settings.accelerationAvailable && <Alert><AlertDescription>{t("globalSettings.accelerationUnavailable")}</AlertDescription></Alert>}
        {section !== "context" && <FieldGroup className={cn("grid gap-x-8 gap-y-3", section !== "models" && "md:grid-cols-2")}>
          <SettingsRow label={t("settingsFields.currentProvider")} value={settings.provider} badge />
          {section === "models" && <>
          <ManagedSelect fullWidth label={t("settingsFields.defaultModel")} value={defaultDraft.model} placeholder={t("settingsFields.selectValidModel")} options={modelOptions} disabledValues={unavailableModel !== null ? [unavailableModel] : []} disabled={officialDisabled} onChange={value => { const model = settings.models.find(candidate => candidate.model === value); if (model) patchDefaults({ model: value, reasoning: model.reasoningEfforts.some(candidate => candidate.effort === defaultDraft.reasoning) ? defaultDraft.reasoning : model.defaultReasoningEffort }) }} />
          <ManagedSelect fullWidth label={t("settingsFields.reasoningEffort")} value={defaultDraft.reasoning} placeholder={t("managementUi.followModelDefault")} options={draftEfforts} disabledValues={draftEffortValid ? [] : [defaultDraft.reasoning]} disabled={officialDisabled || draftModel === undefined} onChange={reasoning => patchDefaults({ reasoning })} />
          <Button className="self-start" variant="outline" disabled={officialDisabled || !draftModel || !draftEffortValid || defaultDraft.model === settings.defaults.model && defaultDraft.reasoning === settings.defaults.reasoningEffort} onClick={() => void management.previewSetting({ kind: "defaults", model: defaultDraft.model, reasoningEffort: defaultDraft.reasoning }, { key: "settingsFields.defaultModel" })}>{t("modelManagement.preview")}</Button>
          <Separator />
          <ManagedSelect fullWidth label={t("settingsFields.serviceTier")} value={serviceTier} placeholder={t("settingsFields.serviceTierDefault")} options={serviceTierOptions} disabledValues={serviceTierUnavailable ? [serviceTier] : []} description={t("settingsFields.serviceTierHint")} disabled={officialDisabled} onChange={tier => patchTier({ tier })} />
          <Button className="self-start" variant="outline" disabled={officialDisabled || serviceTierUnavailable || !["default", "fast", "ultrafast"].includes(serviceTier) || serviceTier === (settings.defaults.serviceTier === null ? "" : normalizeServiceTier(settings.defaults.serviceTier)) || defaultDraft.model !== (settings.defaults.model ?? "") || defaultDraft.reasoning !== (settings.defaults.reasoningEffort ?? "")} onClick={() => { if (serviceTier === "default" || serviceTier === "fast" || serviceTier === "ultrafast") void management.previewSetting({ kind: "service-tier", serviceTier }, { key: "settingsFields.serviceTier" }) }}>{t("modelManagement.preview")}</Button>
          </>}
          {section === "general" && <>
          <ManagedSelect fullWidth label={t("settingsFields.webSearch")} value={settings.defaults.webSearch ?? ""} placeholder={unsetLabel("webSearch")} description={t("openAiModelCatalog.searchDefaultHint")} options={[["live", t("settingsFields.live")], ["indexed", t("settingsFields.indexed")], ["cached", t("settingsFields.cached")], ["disabled", t("settingsFields.off")]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "web-search", mode: value }, { key: "settingsFields.webSearch" })} />
          <ManagedSelect fullWidth label={t("settingsFields.updatePlan")} value={settings.defaults.updatePlanEnabled === null ? "" : String(settings.defaults.updatePlanEnabled)} placeholder={unsetLabel("updatePlanEnabled")} options={[["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "update-plan", enabled: value === "true" }, { key: "settingsFields.updatePlan" })} />
          <ManagedSelect fullWidth label={t("settingsFields.autoRecap")} value={settings.defaults.autoRecapEnabled === null ? "" : String(settings.defaults.autoRecapEnabled)} placeholder={unsetLabel("autoRecapEnabled")} options={[["false", t("settingsFields.off")], ["true", t("settingsFields.on")]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "auto-recap", enabled: value === "true" }, { key: "settingsFields.autoRecap" })} />
          </>}
          {section === "permissions" && <>
          <ManagedSelect label={t("settingsFields.approvalsReviewer")} value={settings.approvalsReviewer.value ?? ""} placeholder={t("settingsFields.approvalsReviewerUnset")} options={[["user", t("settingsFields.manualReview")], ["auto_review", t("settingsFields.autoReview")]]} disabled={busy || !settings.approvalsReviewer.editable} description={t(reviewerHint)} onChange={(value) => void management.previewSetting({ kind: "approvals-reviewer", value }, { key: "settingsFields.approvalsReviewer" })} />
          <ManagedSelect label="Sandbox" value={settings.permissions.sandboxMode ?? ""} placeholder={t(settings.permissions.unsupportedFields.includes("sandboxMode") ? "settingsFields.permissionUnsupported" : "settingsFields.permissionInherited")} description={t("settingsFields.permissionSingleHint")} options={[["read-only", t("settingsFields.readOnly")], ["workspace-write", t("settingsFields.workspaceWrite")]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: value }, { key: "settingsFields.sandbox" })} />
          <ManagedSelect label={t("settingsFields.approvalPolicy")} value={settings.permissions.approvalPolicy ?? ""} placeholder={t(settings.permissions.unsupportedFields.includes("approvalPolicy") ? "settingsFields.permissionUnsupported" : "settingsFields.permissionInherited")} description={t("settingsFields.permissionSingleHint")} options={[["on-request", t("settingsFields.onRequest")], ["never", t("settingsFields.never")]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", approvalPolicy: value }, { key: "settingsFields.approvalPolicy" })} />
          <ManagedSelect label={t("settingsFields.networkAccess")} value={settings.permissions.networkAccess === null ? "" : String(settings.permissions.networkAccess)} placeholder={t(settings.permissions.unsupportedFields.includes("networkAccess") ? "settingsFields.permissionUnsupported" : "settingsFields.permissionInherited")} description={t("settingsFields.permissionSingleHint")} options={[["true", t("settingsFields.allowed")], ["false", t("settingsFields.denied")]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", networkAccess: value === "true" }, { key: "settingsFields.networkAccess" })} />
          <SettingsRow label="Permission Profile" value={settings.permissions.defaultPermissions ?? t("settingsFields.notConfigured")} code />
          </>}
        </FieldGroup>}

        {section === "context" && <>
        <section className="flex flex-col gap-3">
          <div><h3 className="font-medium">{t("settingsFields.contextCompaction")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.contextHint")}</p></div>
          <FieldGroup className="grid gap-3">
            <Field data-disabled={officialDisabled} data-invalid={visibleCompactError?.field === "contextWindow"}>
              <FieldLabel htmlFor="codex-context-window">{t("settingsFields.contextWindow")}</FieldLabel>
              <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[windowPreset]} disabled={officialDisabled} aria-label={t("managementUi.contextPreset")} onValueChange={([preset]) => {
                if (preset === undefined) return
                if (preset === "custom") { setCustomWindow(true); return }
                setCustomWindow(false)
                patchCompact({ contextWindow: preset === "default" ? "" : preset })
                setCompactError(null)
              }}>
                <ToggleGroupItem value="default">{t("managementUi.followModelDefault")}</ToggleGroupItem>
                {contextWindowPresetTokens.map(tokens => <ToggleGroupItem key={tokens} value={String(tokens)} title={t("managementUi.contextPresetLabel", { label: contextWindowPresetLabel(tokens), tokens })}>{contextWindowPresetLabel(tokens)}</ToggleGroupItem>)}
                <ToggleGroupItem value="custom">{t("openAiModelCatalog.contextCustom")}</ToggleGroupItem>
              </ToggleGroup>
              <Input id="codex-context-window" type="number" min={1} value={contextWindow} disabled={officialDisabled} aria-invalid={visibleCompactError?.field === "contextWindow"} aria-describedby={visibleCompactError?.field === "contextWindow" ? "codex-context-window-error" : undefined} onChange={(event) => { setCustomWindow(false); patchCompact({ contextWindow: event.target.value }); setCompactError(null) }} placeholder={t("settingsFields.modelDefault")} />
              {visibleCompactError?.field === "contextWindow" ? <FieldError id="codex-context-window-error">{t(visibleCompactError.message)}</FieldError> : null}
            </Field>
            <Field data-disabled={officialDisabled} data-invalid={visibleCompactError?.field === "autoCompactTokenLimit"}>
              <FieldLabel htmlFor="codex-compact-token-limit">{t("settingsFields.compactTokenLimit")}</FieldLabel>
              <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[compactPreset]} disabled={officialDisabled} aria-label={t("settingsFields.compactPreset")} aria-describedby="codex-compact-preset-hint" onValueChange={([preset]) => {
                if (preset === undefined) return
                if (preset === "custom") { setCompactChoice({ preset, window: contextWindow, threshold: autoCompactTokenLimit }); return }
                if (preset !== "default" && !canUseCompactPercent) return
                const threshold = preset === "default" ? "" : compactTokens(compactWindow, Number(preset))
                setCompactChoice({ preset, window: contextWindow, threshold })
                patchCompact({ autoCompactTokenLimit: threshold })
                setCompactError(null)
              }}>
                <ToggleGroupItem value="default">{t("managementUi.followModelDefault")}</ToggleGroupItem>
                {compactPercentPresets.map(percent => <ToggleGroupItem key={percent} value={String(percent)} disabled={!canUseCompactPercent}>{percent}%</ToggleGroupItem>)}
                <ToggleGroupItem value="custom">{t("openAiModelCatalog.contextCustom")}</ToggleGroupItem>
              </ToggleGroup>
              <Input id="codex-compact-token-limit" type="number" min={1} step={1} value={autoCompactTokenLimit} disabled={officialDisabled} aria-invalid={visibleCompactError?.field === "autoCompactTokenLimit"} aria-describedby={visibleCompactError?.field === "autoCompactTokenLimit" ? "codex-compact-preset-hint codex-compact-token-limit-error" : "codex-compact-preset-hint"} onChange={(event) => { setCompactChoice(null); patchCompact({ autoCompactTokenLimit: event.target.value }); setCompactError(null) }} placeholder={t("settingsFields.compactDefault")} />
              <FieldDescription id="codex-compact-preset-hint">{t(canUseCompactPercent ? "settingsFields.compactPresetHint" : "settingsFields.compactPresetNeedsWindow")}</FieldDescription>
              {visibleCompactError?.field === "autoCompactTokenLimit" ? <FieldError id="codex-compact-token-limit-error">{t(visibleCompactError.message)}</FieldError> : null}
            </Field>
          </FieldGroup>
          <Button className="self-start" variant="outline" disabled={officialDisabled} onClick={saveCompact}>{t("settingsFields.saveCompaction")}</Button>
        </section>

        </>}
        {section === "general" && <>
        <Separator />
        <section className="flex flex-col gap-3">
          <div><h3 className="font-medium">{t("settingsFields.preferences")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.preferencesHint")}</p></div>
          <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
            <ManagedSelect fullWidth label={t("settingsFields.planEffort")} value={settings.defaults.planModeReasoningEffort ?? "inherit"} options={[["inherit", t("settingsFields.inheritUserSetting")], ...(settings.defaults.planModeReasoningEffort && !effortOptions.some(([value]) => value === settings.defaults.planModeReasoningEffort) ? [[settings.defaults.planModeReasoningEffort, settings.defaults.planModeReasoningEffort]] : []), ...effortOptions]} disabledValues={settings.defaults.planModeReasoningEffort && !effortOptions.some(([value]) => value === settings.defaults.planModeReasoningEffort) ? [settings.defaults.planModeReasoningEffort] : []} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "preferences", planModeReasoningEffort: value === "inherit" ? null : value }, { key: "settingsFields.planEffort" })} />
            <ManagedSelect fullWidth label={t("settingsFields.reasoningSummary")} value={preferenceValue("reasoningSummary", settings.defaults.reasoningSummary)} options={preferenceOptions("reasoningSummary", [["auto", t("settingsFields.auto")], ["concise", t("settingsFields.concise")], ["detailed", t("settingsFields.detailed")], ["none", t("settingsFields.summaryNone")]])} disabledValues={["unsupported"]} disabled={busy} onChange={(value) => { if (value === "inherit" || value === "auto" || value === "concise" || value === "detailed" || value === "none") void management.previewSetting({ kind: "preferences", reasoningSummary: value === "inherit" ? null : value }, { key: "settingsFields.reasoningSummary" }) }} />
            <ManagedSelect fullWidth label={t("settingsFields.verbosity")} value={preferenceValue("verbosity", settings.defaults.verbosity)} options={preferenceOptions("verbosity", [["low", t("settingsFields.low")], ["medium", t("settingsFields.medium")], ["high", t("settingsFields.high")]])} disabledValues={["unsupported"]} disabled={busy} onChange={(value) => { if (value === "inherit" || value === "low" || value === "medium" || value === "high") void management.previewSetting({ kind: "preferences", verbosity: value === "inherit" ? null : value }, { key: "settingsFields.verbosity" }) }} />
            <ManagedSelect fullWidth label={t("settingsFields.startupUpdate")} value={preferenceValue("checkForUpdateOnStartup", settings.defaults.checkForUpdateOnStartup)} options={preferenceOptions("checkForUpdateOnStartup", [["true", t("settingsFields.on")], ["false", t("settingsFields.off")]])} disabledValues={["unsupported"]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "preferences", checkForUpdateOnStartup: value === "inherit" ? null : value === "true" }, { key: "settingsFields.startupUpdate" })} />
            <ManagedSelect fullWidth label={t("settingsFields.historyPersistence")} value={preferenceValue("historyPersistence", settings.defaults.historyPersistence)} options={preferenceOptions("historyPersistence", [["save-all", t("settingsFields.save")], ["none", t("settingsFields.doNotSave")]])} disabledValues={["unsupported"]} disabled={busy} onChange={(value) => { if (value === "inherit" || value === "save-all" || value === "none") void management.previewSetting({ kind: "preferences", historyPersistence: value === "inherit" ? null : value }, { key: "settingsFields.historyPersistence" }) }} />
          </FieldGroup>
        </section>

        </>}
        {section === "permissions" && <><Separator /><ToolAccessSettings management={management} /></>}
        {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
      </div>
  return <>
    <PendingSettingDialog className={section === "models" ? modelOperationDialogClassName : undefined} pending={management.pendingSetting} saving={management.saving} loading={management.loading} onConfirm={() => void confirmSetting()} onCancel={management.cancelSetting} />
    {renderContent && management.error !== null && <SettingsError title={t("settingsUi.codexLoadFailed")} message={management.error} retry={management.refetch} />}
    {feedback}
    {renderContent ? renderContent(content) : <Card>
      <CardHeader><CardTitle>{t(section === "models" ? "settingsFields.modelDefaults" : section === "context" ? "settingsFields.codexContext" : section === "permissions" ? "navigation.codexPermissions" : "navigation.codexGeneral")}</CardTitle><CardDescription>{t("navigation.configurationHint")}</CardDescription></CardHeader>
      <CardContent>{content}</CardContent>
    </Card>}
  </>
}
