import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react"
import { AccountIdField } from "@/components/settings/account-id-field"
import { newManagedAccountIdError, opencodeGoReservedAccountIds } from "../../../../runtime/managed-provider-account-options.mjs"
import { useTranslation } from "@/hooks/use-translation"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ManagedSelect, ManagementConfirmationDialog, SettingsMutationFeedback, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { AccountSettingsController } from "@/lib/settings-management"
import { ModelIdentityFields, ModelCapabilityFields, type ModelCapabilityFieldsValue } from "@/components/settings/model-definition-fields"
import { defaultModelDisplayName } from "../../../../runtime/model-catalog.mjs"
import { validContextWindow } from "@/lib/model-context-window"

export type Platform = "opencodeGo" | "deepseek" | "clinePass" | "ollamaCloud"
const platforms: Record<Platform, string> = { opencodeGo: "OpenCode Go", deepseek: "DeepSeek", clinePass: "Cline Pass", ollamaCloud: "Ollama Cloud" }
type AccountMode = "switching" | "exclusive"
export type AccountRow = { id: string; provider: string; platform: Platform; name: string; contact: string; model: string; mode: AccountMode | null; default: boolean }
export type AccountDirectoryActions = { rows: AccountRow[]; fresh: boolean; disabled: boolean; editing: boolean; open: (platform: Platform, row?: AccountRow) => void; action: (row: AccountRow, kind: "default" | "remove") => void; setTrigger: (node: HTMLButtonElement) => void }
type AccountSettingsManagementProps = { management: AccountSettingsController; onChanged?: () => void; onEditingChange?: (editing: boolean) => void; renderAccounts: (actions: AccountDirectoryActions | null) => ReactNode }

export function AccountSettingsManagement({ management, onChanged, onEditingChange, renderAccounts }: AccountSettingsManagementProps) {
  const { t } = useTranslation()
  const settings = management.settings
  if (settings === null) return <>{management.loading ? <LoadingSettingsCard title={t("modelManagement.accounts")} /> : <SettingsError message={management.error ?? t("modelManagement.unavailable")} retry={management.refetch} />}{renderAccounts(null)}</>
  return <>{management.error && <SettingsError message={management.error} retry={management.refetch} />}<AccountSettingsCard management={management} settings={settings} onChanged={onChanged} onEditingChange={onEditingChange} renderAccounts={renderAccounts} /></>
}

function AccountSettingsCard({ management, settings, onChanged, onEditingChange, renderAccounts }: AccountSettingsManagementProps & { settings: NonNullable<AccountSettingsController["settings"]> }) {
  const { t } = useTranslation()
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [editor, setEditor] = useState<Platform | null>(null)
  const [editing, setEditing] = useState(false)
  const [accountId, setAccountId] = useState("")
  const [mode, setMode] = useState<AccountMode | null>("switching")
  const [key, setKey] = useState("")
  const [model, setModel] = useState("")
  const [modelName, setModelName] = useState("")
  const [capabilities, setCapabilities] = useState<ModelCapabilityFieldsValue>({ contextWindow: "", reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: undefined, supportsPatch: false, supportsSearch: false })
  const initialCatalog = editor === "ollamaCloud" && !settings.ollamaCloud.catalogExists
  const modelValid = editor !== "ollamaCloud" || (initialCatalog
    ? model.length > 0 && modelName.trim().length > 0 && validContextWindow(capabilities.contextWindow, 1024, 100000000) && (capabilities.reasoningEfforts?.length ?? 0) > 0 && capabilities.reasoningEfforts?.includes(capabilities.defaultReasoningEffort ?? "") && typeof capabilities.supportsImages === "boolean"
    : settings.ollamaCloud.models.some(entry => entry.id === model))
  const pending = management.pendingPreview
  const disabled = management.busy || management.loading || management.error !== null || management.readbackRequired || pending !== null
  const rows: AccountRow[] = [
    ...settings.opencodeGo.accounts.map(account => ({ id: account.id, provider: account.provider, platform: "opencodeGo" as const, name: account.displayName, contact: account.email ?? account.phone ?? "", model: account.model ?? "", mode: account.mode ?? null, default: account.default })),
    ...settings.deepseek.accounts.map(account => ({ id: account.id, provider: account.provider, platform: "deepseek" as const, name: account.id, contact: "", model: account.model ?? "", mode: account.mode ?? null, default: account.default })),
    ...settings.clinePass.accounts.map(account => ({ id: account.id, provider: account.provider, platform: "clinePass" as const, name: account.id, contact: "", model: account.model ?? "", mode: account.mode ?? null, default: account.default })),
    ...settings.ollamaCloud.accounts.map(account => ({ id: account.id, provider: account.provider, platform: "ollamaCloud" as const, name: account.id, contact: "", model: account.model ?? "", mode: account.mode ?? null, default: account.default })),
  ]
  useEffect(() => {
    onEditingChange?.(editor !== null)
    return () => onEditingChange?.(false)
  }, [editor, onEditingChange])
  const close = () => { setEditor(null); setKey("") }
  const open = (platform: Platform, row?: AccountRow) => {
    management.clearError()
    setEditor(platform); setEditing(Boolean(row)); setAccountId(row?.id ?? ""); setMode(row ? row.mode : "switching"); setKey("")
    setModel(row?.model ?? ""); setModelName(""); setCapabilities({ contextWindow: "", reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: undefined, supportsPatch: false, supportsSearch: false })
  }
  const save = () => {
    if (editor === null || (mode !== "switching" && mode !== "exclusive")) return
    const common = { accountId: accountId.trim(), mode, apiKey: editing && key === "" ? undefined : key, reconfigure: editing }
    if (editor === "opencodeGo") void management.mutate({ ...common, operation: "opencode.account.configure" })
    if (editor === "deepseek") void management.mutate({ operation: "deepseek.configure", ...common })
    if (editor === "clinePass") void management.mutate({ operation: "clp.configure", ...common })
    if (editor === "ollamaCloud" && modelValid) void management.mutate({ operation: "olc.configure", ...common, model,
      ...(initialCatalog ? { initialModel: { id: model, name: modelName, contextWindow: Number(capabilities.contextWindow), reasoningEfforts: capabilities.reasoningEfforts, defaultReasoningEffort: capabilities.defaultReasoningEffort, supportsImages: capabilities.supportsImages, applyPatchToolType: null, supportsSearchTool: false } } : {}),
    })
  }
  const confirm = async () => {
    const result = await management.confirm()
    if (result !== null) { close(); onChanged?.() }
  }
  const cancel = () => { management.cancel() }
  const action = (row: AccountRow, kind: "default" | "remove") => {
    const prefix = row.platform === "opencodeGo" ? "opencode.account" : row.platform === "deepseek" ? "deepseek" : row.platform === "ollamaCloud" ? "olc" : "clp"
    void management.mutate({ operation: `${prefix}.${kind}`, accountId: row.id })
  }
  return <>
    <SettingsMutationFeedback result={management.actionResult} writeUnconfirmed={management.writeUnconfirmed} readbackRequired={management.readbackRequired} />
    {renderAccounts({ rows, fresh: !management.loading && management.error === null && !management.readbackRequired, disabled, editing: editor !== null || pending !== null, open, action, setTrigger: node => { triggerRef.current = node } })}
    <Dialog open={editor !== null} onOpenChange={value => { if (!value && !management.busy && pending === null) close() }}>
      <DialogContent finalFocus={triggerRef} closeLabel={t("modelManagement.cancel")} className={modelOperationDialogClassName} showCloseButton={!management.busy && pending === null}>
        <DialogHeader><DialogTitle>{editor ? platforms[editor] : ""} · {t(editing ? "modelManagement.edit" : "modelManagement.add")}</DialogTitle><DialogDescription>{t("modelManagement.credentialsHint")}</DialogDescription></DialogHeader>
        {management.error !== null && <SettingsError message={management.error} retry={management.refetch} />}
        {management.readbackRequired && <Alert><AlertDescription className="flex flex-col gap-2"><p>{t("settingsUi.readbackUnknown")}</p><Button variant="outline" disabled={management.busy || management.loading} onClick={management.refetch}>{t("common.retry")}</Button></AlertDescription></Alert>}
        {editor && <FieldGroup>
          <AccountIdField id="model-account-id" value={accountId} accounts={settings[editor].accounts} reservedIds={editor === "opencodeGo" ? opencodeGoReservedAccountIds : undefined} disabled={disabled} editing={editing} onChange={setAccountId} />
          <ManagedSelect fullWidth label={t("modelManagement.mode")} value={mode ?? ""} placeholder={t("common.unknown")} description={editing && mode === null ? t("modelManagement.unknownAccountModeHint") : undefined} options={[["switching", t("modelManagement.switching")], ["exclusive", t("modelManagement.exclusive")]]} disabled={disabled} onChange={value => { if (value === "switching" || value === "exclusive") setMode(value) }} />
          <Field data-disabled={disabled}><FieldLabel htmlFor="model-account-key">API Key</FieldLabel><Input id="model-account-key" type="password" autoComplete="new-password" disabled={disabled} value={key} placeholder={editing ? t("managementUi.preserveCredentials") : undefined} onChange={event => setKey(event.target.value)} /></Field>
          {editor === "ollamaCloud" && <>
            <Alert><AlertDescription>{t("modelManagement.ollamaAuthenticationHint")}</AlertDescription></Alert>
            {initialCatalog ? <>
              <p>{t("modelManagement.ollamaInitialHint")}</p>
              <ModelIdentityFields id={model} name={modelName} disabled={disabled} onIdChange={value => { if (!modelName || modelName === defaultModelDisplayName(model)) setModelName(defaultModelDisplayName(value)); setModel(value) }} onNameChange={setModelName} />
              <ModelCapabilityFields value={capabilities} disabled={disabled} unavailableTools onChange={changes => setCapabilities(previous => ({ ...previous, ...changes, supportsPatch: false, supportsSearch: false }))} />
            </> : <ManagedSelect fullWidth label={t("managementUi.defaultModel")} value={model} placeholder={t("modelManagement.selectModel")} options={settings.ollamaCloud.models.map(entry => [entry.id, `${entry.name} (${entry.id})`])} disabled={disabled} onChange={setModel} />}
          </>}
        </FieldGroup>}
        {management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={management.busy || pending !== null} onClick={close}>{t("modelManagement.cancel")}</Button><Button disabled={disabled || !modelValid || !editor || (mode !== "switching" && mode !== "exclusive") || (!key.trim() && !(editing && key === "")) || (!editing && Boolean(newManagedAccountIdError(accountId, editor ? settings[editor].accounts : [], editor === "opencodeGo" ? opencodeGoReservedAccountIds : undefined)))} onClick={save}>{t("modelManagement.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {pending && <AccountSettingsConfirmationDialog pending={pending} finalFocus={editor === null ? triggerRef : undefined} saving={management.busy} loading={management.loading || management.error !== null || management.readbackRequired} onConfirm={() => void confirm()} onCancel={cancel} />}
    {management.actionError && !editor && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
  </>
}

export function AccountSettingsConfirmationDialog({
  pending,
  saving,
  loading,
  finalFocus,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<AccountSettingsController["pendingPreview"]>
  saving: boolean
  loading?: boolean
  finalFocus?: ComponentProps<typeof ManagementConfirmationDialog>["finalFocus"]
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const preview = pending.preview
  const account = preview.account
  const provider = preview.provider
  const platform = pending.input.operation.startsWith("opencode.") ? platforms.opencodeGo : pending.input.operation.startsWith("deepseek.") ? platforms.deepseek : pending.input.operation.startsWith("olc.") ? platforms.ollamaCloud : platforms.clinePass
  const lines = [t("accountConfirmation.operation", { value: preview.operation }), t("accountConfirmation.platform", { value: platform })]
  if (account?.id !== undefined) lines.push(t("accountConfirmation.account", { name: account.displayName ?? account.email ?? account.phone ?? account.id, id: account.id }))
  if (account?.provider !== undefined) lines.push(t("accountConfirmation.provider", { name: platform, id: account.provider }))
  if (provider?.name !== undefined) lines.push(t("accountConfirmation.provider", { name: provider.name, id: provider.id ?? t("common.unknown") }))
  const modeLabel = (value: string) => value === "exclusive" ? t("modelManagement.exclusive") : value === "switching" ? t("modelManagement.switching") : value
  if (preview.mode !== undefined) lines.push(t("accountConfirmation.mode", { value: preview.previousMode === undefined ? modeLabel(preview.mode) : `${modeLabel(preview.previousMode)} → ${modeLabel(preview.mode)}` }))
  if (preview.credentialAction !== undefined) lines.push(t(preview.credentialAction === "preserve" ? "accountConfirmation.preserveKey" : "accountConfirmation.replaceKey"))
  if (preview.model !== undefined) lines.push(t("accountConfirmation.model", { value: preview.model }))
  if (preview.initialModel !== undefined) {
    const model = preview.initialModel
    lines.push(t("modelManagement.ollamaInitialSummary", { id: model.id, name: model.name, window: String(model.contextWindow), efforts: (model.reasoningEfforts ?? []).join(" / "), defaultEffort: model.defaultReasoningEffort ?? "", images: t(model.supportsImages ? "openAiModelCatalog.supported" : "openAiModelCatalog.unsupported") }))
  }
  if (preview.status !== undefined) lines.push(t("accountConfirmation.status", { value: preview.status }))
  if (preview.effects !== undefined) {
    const effects = Object.entries(preview.effects).filter(([, value]) => value !== false && value !== null && value !== undefined).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
    if (effects.length > 0) lines.push(t("accountConfirmation.effects", { value: effects.join(t("accountConfirmation.listSeparator")) }))
  }
  const removing = pending.input.operation === "opencode.account.remove"
    || pending.input.operation === "clp.remove"
    || pending.input.operation === "olc.remove"
    || pending.input.operation === "deepseek.remove"
  const stopping = pending.input.operation === "opencode.account.stop"
  const destructive = stopping || removing
  return <ManagementConfirmationDialog className={modelOperationDialogClassName} finalFocus={finalFocus} open saving={saving} loading={loading} title={removing ? t("accountConfirmation.removeTitle") : t("accountConfirmation.changeTitle")} description={removing ? t("accountConfirmation.removeDescription") : stopping ? t("accountConfirmation.stopDescription") : t("accountConfirmation.changeDescription")} confirmVariant={destructive ? "destructive" : "default"} confirmLabel={removing ? t("accountConfirmation.confirmRemove") : stopping ? t("accountConfirmation.confirmStop") : t("accountConfirmation.confirmWrite")} onConfirm={onConfirm} onCancel={onCancel}>
    {removing ? <p>{t("accountConfirmation.historyWarning")}</p> : null}
    {pending.input.operation === "opencode.account.remove" ? <p>{t("accountConfirmation.subscriptionWarning")}</p> : null}
    <p className="whitespace-pre-line">{lines.join("\n")}</p>
    <p className="text-muted-foreground">{t("accountConfirmation.activation", { value: preview.activation === "none" ? t(preview.willChange === false ? "settingsUi.unchanged" : "settingsUi.noActivationRequired") : preview.activation === "restart-all" ? t("settingsUi.restartAll") : preview.activation ?? t("accountConfirmation.activationFallback") })}</p>
  </ManagementConfirmationDialog>
}
