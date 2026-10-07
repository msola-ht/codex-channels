import { useTranslation } from "@/hooks/use-translation"
import { useEffect, useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ManagedSelect, PendingSettingDialog, SettingsRow } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { CodexSettingsController } from "@/lib/settings-management"
import type { MessageKey } from "@/lib/i18n/messages"
import { ToolAccessSettings } from "@/components/settings/tool-access-settings"

export function AppServerSettingsCard({ management, onChanged, section = "general" }: { management: CodexSettingsController; onChanged?: () => void; section?: "general" | "permissions" | "models" | "context" }) {
  const { t } = useTranslation()
  const settings = management.codexSettings
  const selectedModel = settings?.models.find((model) => model.model === settings.defaults.model) ?? settings?.models[0]
  const [compact, patchCompact, resetCompact] = useSettingsDraft({ contextWindow: settings?.compact.contextWindow == null ? "" : String(settings.compact.contextWindow), compactPercent: settings?.compact.autoCompactPercent == null ? "" : String(settings.compact.autoCompactPercent) })
  const [preferences, patchPreferences, resetPreferences] = useSettingsDraft({
    planEffort: settings?.defaults.planModeReasoningEffort ?? selectedModel?.defaultReasoningEffort ?? "",
    reasoningSummary: settings?.defaults.reasoningSummary ?? "none", verbosity: settings?.defaults.verbosity ?? "medium",
    startupUpdate: String(settings?.defaults.checkForUpdateOnStartup ?? true), historyPersistence: settings?.defaults.historyPersistence ?? "save-all",
  })
  const { contextWindow, compactPercent } = compact
  const { planEffort, reasoningSummary, verbosity, startupUpdate, historyPersistence } = preferences
  const [localError, setLocalError] = useState<MessageKey | null>(null)
  const [compactError, setCompactError] = useState<{ field: "contextWindow" | "compactPercent"; value: string; requiredByPercent?: string; message: MessageKey } | null>(null)
  const visibleCompactError = compactError !== null
    && compactError.value === compact[compactError.field]
    && (compactError.requiredByPercent === undefined || compactError.requiredByPercent === compactPercent)
      ? compactError : null
  useEffect(() => {
    if (management.lastAppliedSetting?.kind === "model-compact") resetCompact()
    if (management.lastAppliedSetting?.kind === "preferences") resetPreferences()
  }, [management.lastAppliedSetting, resetCompact, resetPreferences])

  if (management.loading && settings === null) return <LoadingSettingsCard title={t("settingsFields.appServerTitle")} />
  if (settings === null) return <SettingsError message={management.error ?? t("settingsFields.appServerUnavailable")} retry={management.refetch} />

  const confirmSetting = async () => {
    if (await management.confirmSetting()) onChanged?.()
  }
  const selected = settings.models.find((model) => model.model === settings.defaults.model) ?? settings.models[0]
  const effortOptions = selected?.reasoningEfforts.map((item) => [item.effort, item.effort]) ?? []
  const busy = management.loading || management.error !== null || management.saving || management.pendingSetting !== null
  const officialDisabled = busy || !settings.defaultsEditable
  const reviewerHint: MessageKey = settings.approvalsReviewer?.editable
    ? "settingsFields.autoReviewHint"
    : settings.approvalsReviewer?.reason === "managed-policy"
      ? "settingsFields.autoReviewManaged"
      : settings.approvalsReviewer?.reason === "unsupported-value"
        ? "settingsFields.autoReviewUnsupported"
        : "settingsFields.autoReviewUnavailable"

  const saveCompact = () => {
    const parsedWindow = contextWindow.trim() === "" ? null : Number(contextWindow)
    const parsedPercent = compactPercent.trim() === "" ? null : Number(compactPercent)
    if (parsedWindow !== null && (!Number.isSafeInteger(parsedWindow) || parsedWindow <= 0)) {
      setCompactError({ field: "contextWindow", value: contextWindow, message: "settingsFields.contextWindowInvalid" })
      return
    }
    if (parsedPercent !== null && (!Number.isInteger(parsedPercent) || parsedPercent < 10 || parsedPercent > 90)) {
      setCompactError({ field: "compactPercent", value: compactPercent, message: "settingsFields.compactPercentInvalid" })
      return
    }
    if (parsedPercent !== null && parsedWindow === null) {
      setCompactError({ field: "contextWindow", value: contextWindow, requiredByPercent: compactPercent, message: "settingsFields.contextWindowRequired" })
      return
    }
    setCompactError(null)
    void management.previewSetting({ kind: "model-compact", contextWindow: parsedWindow, autoCompactPercent: parsedPercent }, { key: "settingsFields.contextCompaction" })
  }

  const savePreferences = () => {
    if (planEffort === "") {
      setLocalError("settingsFields.planEffortUnavailable")
      return
    }
    setLocalError(null)
    void management.previewSetting({
      kind: "preferences",
      planModeReasoningEffort: planEffort,
      reasoningSummary,
      verbosity,
      checkForUpdateOnStartup: startupUpdate === "true",
      historyPersistence,
    }, { key: "settingsFields.preferences" })
  }

  return <>
    <PendingSettingDialog pending={management.pendingSetting} saving={management.saving} loading={management.loading} onConfirm={() => void confirmSetting()} onCancel={management.cancelSetting} />
    <Card>
      <CardHeader><CardTitle>{t(section === "models" ? "settingsFields.modelDefaults" : section === "context" ? "settingsFields.codexContext" : section === "permissions" ? "navigation.codexPermissions" : "navigation.codexGeneral")}</CardTitle><CardDescription>{t("navigation.configurationHint")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-5 text-sm">
      {management.error !== null ? <SettingsError message={management.error} retry={management.refetch} /> : null}
        {section !== "context" && <FieldGroup className="grid gap-x-8 gap-y-3 md:grid-cols-2">
          <SettingsRow label={t("settingsFields.currentProvider")} value={settings.provider} badge />
          {section === "models" && <>
          <ManagedSelect label={t("settingsFields.defaultModel")} value={settings.defaults.model ?? ""} options={settings.models.map((model) => [model.model, model.displayName])} disabled={officialDisabled} onChange={(value) => { const model = settings.models.find((candidate) => candidate.model === value); void management.previewSetting({ kind: "defaults", model: value, reasoningEffort: model?.defaultReasoningEffort ?? "medium" }, { key: "settingsFields.defaultModel" }) }} />
          <ManagedSelect label={t("settingsFields.reasoningEffort")} value={settings.defaults.reasoningEffort ?? ""} options={effortOptions} disabled={officialDisabled || selected === undefined} onChange={(value) => void management.previewSetting({ kind: "defaults", model: selected?.model ?? "", reasoningEffort: value }, { key: "settingsFields.reasoningEffort" })} />
          <ManagedSelect label="Fast" value={String(settings.defaults.fastEnabled)} options={[["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={officialDisabled} onChange={(value) => void management.previewSetting({ kind: "fast", enabled: value === "true" }, { key: "settingsFields.fast" })} />
          </>}
          {section === "general" && <>
          <ManagedSelect label={t("settingsFields.webSearch")} value={settings.defaults.webSearch ?? "disabled"} options={[["live", t("settingsFields.live")], ["indexed", t("settingsFields.indexed")], ["cached", t("settingsFields.cached")], ["disabled", t("settingsFields.off")]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "web-search", mode: value }, { key: "settingsFields.webSearch" })} />
          <ManagedSelect label={t("settingsFields.updatePlan")} value={String(settings.defaults.updatePlanEnabled)} options={[["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "update-plan", enabled: value === "true" }, { key: "settingsFields.updatePlan" })} />
          <ManagedSelect label={t("settingsFields.autoRecap")} value={String(settings.defaults.autoRecapEnabled)} options={[["false", t("settingsFields.off")], ["true", t("settingsFields.on")]]} disabled={busy} onChange={(value) => void management.previewSetting({ kind: "auto-recap", enabled: value === "true" }, { key: "settingsFields.autoRecap" })} />
          </>}
          {section === "permissions" && <>
          <ManagedSelect label={t("settingsFields.approvalsReviewer")} value={settings.approvalsReviewer.value ?? ""} placeholder={t("settingsFields.approvalsReviewerUnset")} options={[["user", t("settingsFields.manualReview")], ["auto_review", t("settingsFields.autoReview")]]} disabled={busy || !settings.approvalsReviewer.editable} description={t(reviewerHint)} onChange={(value) => void management.previewSetting({ kind: "approvals-reviewer", value }, { key: "settingsFields.approvalsReviewer" })} />
          <ManagedSelect label="Sandbox" value={settings.permissions.sandboxMode ?? "read-only"} options={[["read-only", t("settingsFields.readOnly")], ["workspace-write", t("settingsFields.workspaceWrite")]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: value, approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: settings.permissions.networkAccess ?? false }, { key: "settingsFields.sandbox" })} />
          <ManagedSelect label={t("settingsFields.approvalPolicy")} value={settings.permissions.approvalPolicy ?? "on-request"} options={[["on-request", t("settingsFields.onRequest")], ["never", t("settingsFields.never")]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: value, networkAccess: settings.permissions.networkAccess ?? false }, { key: "settingsFields.approvalPolicy" })} />
          <ManagedSelect label={t("settingsFields.networkAccess")} value={String(settings.permissions.networkAccess ?? false)} options={[["true", t("settingsFields.allowed")], ["false", t("settingsFields.denied")]]} disabled={busy || !settings.permissions.editable} onChange={(value) => void management.previewSetting({ kind: "permissions", sandboxMode: settings.permissions.sandboxMode ?? "read-only", approvalPolicy: settings.permissions.approvalPolicy ?? "on-request", networkAccess: value === "true" }, { key: "settingsFields.networkAccess" })} />
          <SettingsRow label="Permission Profile" value={settings.permissions.defaultPermissions ?? t("settingsFields.notConfigured")} code />
          </>}
        </FieldGroup>}

        {section === "context" && <>
        <section className="flex flex-col gap-3">
          <div><h3 className="font-medium">{t("settingsFields.contextCompaction")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.contextHint")}</p></div>
          <FieldGroup className="grid gap-3 md:grid-cols-2">
            <Field data-disabled={officialDisabled} data-invalid={visibleCompactError?.field === "contextWindow"}>
              <FieldLabel htmlFor="codex-context-window">{t("settingsFields.contextWindow")}</FieldLabel>
              <Input id="codex-context-window" type="number" min={1} value={contextWindow} disabled={officialDisabled} aria-invalid={visibleCompactError?.field === "contextWindow"} aria-describedby={visibleCompactError?.field === "contextWindow" ? "codex-context-window-error" : undefined} onChange={(event) => { patchCompact({ contextWindow: event.target.value }); setCompactError(null) }} placeholder={t("settingsFields.modelDefault")} />
              {visibleCompactError?.field === "contextWindow" ? <FieldError id="codex-context-window-error">{t(visibleCompactError.message)}</FieldError> : null}
            </Field>
            <Field data-disabled={officialDisabled} data-invalid={visibleCompactError?.field === "compactPercent"}>
              <FieldLabel htmlFor="codex-compact-percent">{t("settingsFields.compactPercent")}</FieldLabel>
              <Input id="codex-compact-percent" type="number" min={10} max={90} value={compactPercent} disabled={officialDisabled} aria-invalid={visibleCompactError?.field === "compactPercent"} aria-describedby={visibleCompactError?.field === "compactPercent" ? "codex-compact-percent-error" : undefined} onChange={(event) => { patchCompact({ compactPercent: event.target.value }); setCompactError(null) }} placeholder={t("settingsFields.compactDefault")} />
              {visibleCompactError?.field === "compactPercent" ? <FieldError id="codex-compact-percent-error">{t(visibleCompactError.message)}</FieldError> : null}
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
            <ManagedSelect label={t("settingsFields.planEffort")} value={planEffort} options={effortOptions} disabled={officialDisabled} onChange={(value) => patchPreferences({ planEffort: value })} />
            <ManagedSelect label={t("settingsFields.reasoningSummary")} value={reasoningSummary} options={[["auto", t("settingsFields.auto")], ["concise", t("settingsFields.concise")], ["detailed", t("settingsFields.detailed")], ["none", t("settingsFields.summaryNone")]]} disabled={officialDisabled} onChange={(value) => patchPreferences({ reasoningSummary: value })} />
            <ManagedSelect label={t("settingsFields.verbosity")} value={verbosity} options={[["low", t("settingsFields.low")], ["medium", t("settingsFields.medium")], ["high", t("settingsFields.high")]]} disabled={officialDisabled} onChange={(value) => patchPreferences({ verbosity: value })} />
            <ManagedSelect label={t("settingsFields.startupUpdate")} value={startupUpdate} options={[["true", t("settingsFields.on")], ["false", t("settingsFields.off")]]} disabled={officialDisabled} onChange={(value) => patchPreferences({ startupUpdate: value })} />
            <ManagedSelect label={t("settingsFields.historyPersistence")} value={historyPersistence} options={[["save-all", t("settingsFields.save")], ["none", t("settingsFields.doNotSave")]]} disabled={officialDisabled} onChange={(value) => patchPreferences({ historyPersistence: value })} />
          </FieldGroup>
          <Button className="self-start" variant="outline" disabled={officialDisabled || planEffort === ""} onClick={savePreferences}>{t("settingsFields.savePreferences")}</Button>
        </section>

        </>}
        {section === "permissions" && <><Separator /><ToolAccessSettings management={management} /></>}
        {localError !== null ? <Alert variant="destructive"><AlertDescription>{t(localError)}</AlertDescription></Alert> : null}
        {management.actionError !== null ? <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert> : null}
      </CardContent>
    </Card>
  </>
}
