import { useState } from "react"
import { AccountIdField } from "@/components/settings/account-id-field"
import { newManagedAccountIdError, opencodeGoReservedAccountIds } from "../../../../runtime/managed-provider-account-options.mjs"
import { useTranslation } from "@/hooks/use-translation"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { DataTable, TruncatedText, type DataTableColumn } from "@/components/metrics/data-table"
import { ManagedSelect, ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsError } from "@/components/settings/settings-feedback"
import type { AccountSettingsController } from "@/lib/settings-management"

type Platform = "opencodeGo" | "deepseek" | "clinePass"
const platforms: Record<Platform, string> = { opencodeGo: "OpenCode Go", deepseek: "DeepSeek", clinePass: "Cline Pass" }
type AccountRow = { id: string; platform: Platform; name: string; contact: string; model: string; mode: "switching" | "exclusive"; default: boolean }

export function AccountSettingsManagement({ management, onChanged }: { management: AccountSettingsController; onChanged?: () => void }) {
  const { t } = useTranslation()
  const settings = management.settings
  if (management.loading && settings === null) return <LoadingSettingsCard title={t("modelManagement.accounts")} />
  if (settings === null) return <SettingsError message={management.error ?? t("modelManagement.unavailable")} retry={management.refetch} />
  return <>{management.error && <SettingsError message={management.error} retry={management.refetch} />}<AccountSettingsCard management={management} settings={settings} onChanged={onChanged} /></>
}

function AccountSettingsCard({ management, settings, onChanged }: { management: AccountSettingsController; settings: NonNullable<AccountSettingsController["settings"]>; onChanged?: () => void }) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState("all")
  const [editor, setEditor] = useState<Platform | null>(null)
  const [editing, setEditing] = useState(false)
  const [accountId, setAccountId] = useState("")
  const [contact, setContact] = useState("")
  const [mode, setMode] = useState<"switching" | "exclusive">("switching")
  const [key, setKey] = useState("")
  const pending = management.pendingPreview
  const disabled = management.busy || management.loading || management.error !== null || pending !== null
  const rows: AccountRow[] = [
    ...settings.opencodeGo.accounts.map(account => ({ id: account.id, platform: "opencodeGo" as const, name: account.displayName, contact: account.email ?? account.phone ?? "", model: "", mode: account.mode ?? "switching" as const, default: account.default })),
    ...settings.deepseek.accounts.map(account => ({ id: account.id, platform: "deepseek" as const, name: account.id, contact: "", model: account.model ?? "", mode: account.mode ?? "switching" as const, default: account.default })),
    ...settings.clinePass.accounts.map(account => ({ id: account.id, platform: "clinePass" as const, name: account.id, contact: "", model: account.model ?? "", mode: account.mode ?? "switching" as const, default: account.default })),
  ]
  const close = () => { setEditor(null); setKey("") }
  const open = (platform: Platform, row?: AccountRow) => {
    management.clearError()
    setEditor(platform); setEditing(Boolean(row)); setAccountId(row?.id ?? ""); setContact(row?.contact ?? ""); setMode(row?.mode ?? "switching"); setKey("")
  }
  const save = () => {
    if (editor === null) return
    const common = { accountId: accountId.trim(), mode, apiKey: key, reconfigure: editing }
    if (editor === "opencodeGo") void management.mutate({ operation: "opencode.account.configure", ...common, contact: contact.trim() })
    if (editor === "deepseek") void management.mutate({ operation: "deepseek.configure", ...common })
    if (editor === "clinePass") void management.mutate({ operation: "clp.configure", ...common })
  }
  const confirm = async () => {
    const result = await management.confirm()
    if (result !== null) { close(); onChanged?.() }
  }
  const cancel = () => { management.cancel(); setKey("") }
  const action = (row: AccountRow, kind: "default" | "remove") => {
    const prefix = row.platform === "opencodeGo" ? "opencode.account" : row.platform === "deepseek" ? "deepseek" : "clp"
    void management.mutate({ operation: `${prefix}.${kind}`, accountId: row.id })
  }
  const columns: DataTableColumn<AccountRow>[] = [
    { accessorKey: "name", header: t("modelManagement.account"), cell: ({ row: { original: row } }) => <div className="flex flex-col gap-1"><TruncatedText text={row.name} /><span className="text-xs text-muted-foreground">{row.id}{row.contact && ` · ${row.contact}`}</span></div> },
    { accessorKey: "platform", header: t("modelManagement.platform"), cell: ({ row }) => platforms[row.original.platform] },
    { accessorKey: "model", header: t("modelManagement.model"), cell: ({ row }) => <TruncatedText text={row.original.model || "—"} /> },
    { accessorKey: "mode", header: t("modelManagement.mode"), cell: ({ row }) => t(row.original.mode === "exclusive" ? "modelManagement.exclusive" : "modelManagement.switching") },
    { accessorKey: "default", header: t("modelManagement.default"), cell: ({ row }) => row.original.default ? <Badge variant="secondary">{t("modelManagement.default")}</Badge> : "—" },
    { id: "actions", header: t("modelManagement.actions"), cell: ({ row: { original: row } }) => <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => open(row.platform, row)}>{t("modelManagement.edit")}</Button>
      <Button variant="outline" size="sm" disabled={disabled || row.default} onClick={() => action(row, "default")}>{t("modelManagement.setDefault")}</Button>
      {row.platform === "opencodeGo" && <Button variant="outline" size="sm" disabled={disabled} onClick={() => void management.mutate({ operation: "opencode.account.stop", accountId: row.id })}>{t("modelManagement.stop")}</Button>}
      <Button variant="destructive" size="sm" disabled={disabled} onClick={() => action(row, "remove")}>{t("modelManagement.remove")}</Button>
    </div> },
  ]
  return <>
    <div className="flex flex-wrap items-center gap-2">
      <Select items={[{ value: "all", label: t("modelManagement.allPlatforms") }, ...Object.entries(platforms).map(([value, label]) => ({ value, label }))]} value={filter} onValueChange={value => { if (value !== null) setFilter(value) }}><SelectTrigger aria-label={t("modelManagement.platform")}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="all">{t("modelManagement.allPlatforms")}</SelectItem>{Object.entries(platforms).map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectGroup></SelectContent></Select>
      {(Object.keys(platforms) as Platform[]).map(platform => <Button key={platform} variant="outline" disabled={disabled} onClick={() => open(platform)}>{t("modelManagement.addAccount", { platform: platforms[platform] })}</Button>)}
    </div>
    <DataTable title={t("modelManagement.accounts")} description={() => t("modelManagement.credentialsHint")} data={rows.filter(row => filter === "all" || row.platform === filter)} columns={columns} getRowId={row => `${row.platform}:${row.id}`} storageKey="codex-webui:model-accounts-v1" pagination={{ mode: "client", defaultSorting: [], defaultPageSize: 10 }} />
    <Dialog open={editor !== null} onOpenChange={value => { if (!value && !management.busy && pending === null) close() }}>
      <DialogContent closeLabel={t("modelManagement.cancel")} className="max-h-[85dvh] overflow-y-auto" showCloseButton={!management.busy && pending === null}>
        <DialogHeader><DialogTitle>{editor ? platforms[editor] : ""} · {t(editing ? "modelManagement.edit" : "modelManagement.add")}</DialogTitle><DialogDescription>{t("modelManagement.credentialsHint")}</DialogDescription></DialogHeader>
        {editor && <FieldGroup>
          <AccountIdField id="model-account-id" value={accountId} accounts={settings[editor].accounts} reservedIds={editor === "opencodeGo" ? opencodeGoReservedAccountIds : undefined} disabled={disabled} editing={editing} onChange={setAccountId} />
          {editor === "opencodeGo" && <Field data-disabled={disabled}><FieldLabel htmlFor="model-account-contact">{t("modelManagement.contact")}</FieldLabel><Input id="model-account-contact" value={contact} disabled={disabled} onChange={event => setContact(event.target.value)} /></Field>}
          <ManagedSelect label={t("modelManagement.mode")} value={mode} options={[["switching", t("modelManagement.switching")], ["exclusive", t("modelManagement.exclusive")]]} disabled={disabled} onChange={value => setMode(value as typeof mode)} />
          <Field data-disabled={disabled}><FieldLabel htmlFor="model-account-key">API Key</FieldLabel><Input id="model-account-key" type="password" autoComplete="new-password" disabled={disabled} value={key} onChange={event => setKey(event.target.value)} /></Field>
        </FieldGroup>}
        {management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
        <DialogFooter><Button variant="outline" disabled={disabled} onClick={close}>{t("modelManagement.cancel")}</Button><Button disabled={disabled || !editor || !key.trim() || (editor === "opencodeGo" && !contact.trim()) || (!editing && Boolean(newManagedAccountIdError(accountId, editor ? settings[editor].accounts : [], editor === "opencodeGo" ? opencodeGoReservedAccountIds : undefined)))} onClick={save}>{t("modelManagement.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {pending && <AccountSettingsConfirmationDialog pending={pending} saving={management.busy} loading={management.loading} onConfirm={() => void confirm()} onCancel={cancel} />}
    {management.actionError && !editor && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
  </>
}

export function AccountSettingsConfirmationDialog({
  pending,
  saving,
  loading,
  onConfirm,
  onCancel,
}: {
  pending: NonNullable<AccountSettingsController["pendingPreview"]>
  saving: boolean
  loading?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const preview = pending.preview
  const account = preview.account
  const provider = preview.provider
  const lines = [t("accountConfirmation.operation", { value: preview.operation })]
  if (account?.id !== undefined) lines.push(t("accountConfirmation.account", { name: account.displayName ?? account.email ?? account.phone ?? account.id, id: account.id }))
  if (provider?.name !== undefined) lines.push(t("accountConfirmation.provider", { name: provider.name, id: provider.id ?? t("common.unknown") }))
  if (preview.mode !== undefined) lines.push(t("accountConfirmation.mode", { value: preview.mode === "exclusive" ? t("modelManagement.exclusive") : preview.mode === "switching" ? t("modelManagement.switching") : preview.mode }))
  if (preview.model !== undefined) lines.push(t("accountConfirmation.model", { value: preview.model }))
  if (preview.status !== undefined) lines.push(t("accountConfirmation.status", { value: preview.status }))
  if (preview.effects !== undefined) {
    const effects = Object.entries(preview.effects).filter(([, value]) => value !== false && value !== null && value !== undefined).map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(",") : String(value)}`)
    if (effects.length > 0) lines.push(t("accountConfirmation.effects", { value: effects.join(t("accountConfirmation.listSeparator")) }))
  }
  const removing = pending.input.operation === "opencode.account.remove"
    || pending.input.operation === "clp.remove"
    || pending.input.operation === "deepseek.remove"
  const stopping = pending.input.operation === "opencode.account.stop"
  const destructive = stopping || removing
  return <ManagementConfirmationDialog open saving={saving} loading={loading} title={removing ? t("accountConfirmation.removeTitle") : t("accountConfirmation.changeTitle")} description={removing ? t("accountConfirmation.removeDescription") : stopping ? t("accountConfirmation.stopDescription") : t("accountConfirmation.changeDescription")} confirmVariant={destructive ? "destructive" : "default"} confirmLabel={removing ? t("accountConfirmation.confirmRemove") : stopping ? t("accountConfirmation.confirmStop") : t("accountConfirmation.confirmWrite")} onConfirm={onConfirm} onCancel={onCancel}>
    {removing ? <p>{t("accountConfirmation.historyWarning")}</p> : null}
    {pending.input.operation === "opencode.account.remove" ? <p>{t("accountConfirmation.subscriptionWarning")}</p> : null}
    <p className="whitespace-pre-line">{lines.join("\n")}</p>
    <p className="text-muted-foreground">{t("accountConfirmation.activation", { value: preview.activation ?? t("accountConfirmation.activationFallback") })}</p>
  </ManagementConfirmationDialog>
}
