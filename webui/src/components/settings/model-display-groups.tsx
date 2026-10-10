import { useEffect, useState } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { validateModelDisplayAliases } from "../../../../runtime/model-display-name.mjs"
import type { GatewaySettingsController } from "@/lib/settings-management"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ManagedSelect } from "@/components/settings/settings-controls"
import { LoadingSettingsCard, SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"

type Draft = { original: string | null; name: string; members: string[]; revision: string; lastApplied: GatewaySettingsController["lastAppliedSetting"] }

export function ModelDisplayGroups({ management, providers, disabled }: {
  management: GatewaySettingsController
  providers: ManagementProviderSettingsResponse | null
  disabled: boolean
}) {
  const { t } = useTranslation()
  const aliases = management.managedSettings?.display.modelAliases ?? {}
  const groups = new Map<string, string[]>()
  for (const [model, name] of Object.entries(aliases)) groups.set(name, [...(groups.get(name) ?? []), model])
  const [editor, setDraft] = useState<Draft | null>(null)
  const draft = editor && (management.lastAppliedSetting === editor.lastApplied || management.lastAppliedSetting?.kind !== "display.model-aliases") ? editor : null
  useEffect(() => {
    if (editor && management.lastAppliedSetting !== editor.lastApplied && management.lastAppliedSetting?.kind === "display.model-aliases") setDraft(null)
  }, [editor, management.lastAppliedSetting])
  const stale = draft !== null && draft.revision !== management.managedSettings?.revision
  const [member, setMember] = useState("")
  const [invalid, setInvalid] = useState({ name: false, member: false, group: false })
  const candidates = new Map<string, string>()
  const targets = new Set<string>()
  for (const provider of providers?.managedProviders ?? []) {
    for (const model of provider.models) {
      const existing = candidates.get(model.id)
      candidates.set(model.id, existing ? `${existing} / ${provider.displayName}` : `${model.id} · ${provider.displayName}`)
      if (provider.id === "deepseek" || provider.id.startsWith("ds-")) targets.add(model.id)
    }
  }
  const open = (name: string | null) => {
    if (!management.managedSettings) return
    management.cancelSetting()
    setDraft({ original: name, name: name ?? "", members: name === null ? [] : groups.get(name) ?? [], revision: management.managedSettings.revision, lastApplied: management.lastAppliedSetting })
    setMember("")
    setInvalid({ name: false, member: false, group: false })
  }
  const addMember = (model: string, fromInput = false) => {
    if (!draft) return
    try {
      validateModelDisplayAliases({ [model]: "display-group" })
      if (draft.members.includes(model) || (Object.hasOwn(aliases, model) && aliases[model] !== draft.original)) throw new Error("member-conflict")
      setDraft({ ...draft, members: [...draft.members, model] })
      setMember("")
      setInvalid(previous => ({ ...previous, member: false, group: false }))
    } catch { setInvalid(previous => ({ ...previous, [fromInput ? "member" : "group"]: true })) }
  }
  const preview = () => {
    if (!draft || stale || disabled) return
    try {
      validateModelDisplayAliases({ "display-group": draft.name })
      if (groups.has(draft.name) && draft.name !== draft.original) throw new Error("group-conflict")
    } catch {
      setInvalid(previous => ({ ...previous, name: true }))
      return
    }
    try {
      if (draft.members.length === 0) throw new Error("empty-group")
      const next = Object.fromEntries(Object.entries(aliases).filter(([, name]) => name !== draft.original))
      for (const model of draft.members) next[model] = draft.name
      validateModelDisplayAliases(next)
      setInvalid(previous => ({ ...previous, name: false, group: false }))
      void management.previewSetting("display.model-aliases", next, { key: "modelDisplay.title" })
    } catch { setInvalid(previous => ({ ...previous, group: true })) }
  }
  if (management.loading && management.managedSettings === null) return <LoadingSettingsCard title={t("modelDisplay.title")} />
  return <>
    <Card>
      <CardHeader><CardTitle>{t("modelDisplay.title")}</CardTitle><CardDescription>{t("modelDisplay.hint")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-3">
        {management.error ? <SettingsError message={management.error} retry={management.refetch} /> : groups.size === 0 ? <SettingsEmpty>{t("modelDisplay.empty")}</SettingsEmpty> : <Table>
          <TableHeader><TableRow><TableHead>{t("modelDisplay.name")}</TableHead><TableHead>{t("modelDisplay.members")}</TableHead><TableHead>{t("modelManagement.actions")}</TableHead></TableRow></TableHeader>
          <TableBody>{[...groups].map(([name, members]) => <TableRow key={name}>
            <TableCell>{name}</TableCell><TableCell><div className="flex flex-col gap-1">{members.map(model => <span key={model} className="break-all">{model}</span>)}</div></TableCell>
            <TableCell><div className="flex gap-2"><Button variant="outline" size="sm" disabled={disabled} onClick={() => open(name)}>{t("modelManagement.edit")}</Button><Button variant="outline" size="sm" disabled={disabled} onClick={() => void management.previewSetting("display.model-aliases", Object.fromEntries(Object.entries(aliases).filter(([, value]) => value !== name)), { key: "modelDisplay.remove", params: { name } })}>{t("modelManagement.remove")}</Button></div></TableCell>
          </TableRow>)}</TableBody>
        </Table>}
        <Button className="self-start" variant="outline" disabled={disabled || management.managedSettings === null} onClick={() => open(null)}>{t("modelDisplay.add")}</Button>
        {!draft && management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
      </CardContent>
    </Card>
    <Dialog open={draft !== null && management.pendingSetting === null} disablePointerDismissal onOpenChange={open => { if (!open && !management.saving) setDraft(null) }}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto" closeLabel={t("modelManagement.cancel")}>
        <DialogHeader><DialogTitle>{t("modelDisplay.title")}</DialogTitle><DialogDescription>{t("modelDisplay.hint")}</DialogDescription></DialogHeader>
        {draft && <FieldGroup>
          {targets.size > 0 && <ManagedSelect label={t("modelDisplay.dsTarget")} value={targets.has(draft.name) ? `model:${draft.name}` : "custom"} options={[["custom", t("modelDisplay.customName")], ...[...targets].map(id => [`model:${id}`, id] as [string, string])]} onChange={selection => {
            const name = selection === "custom" ? "" : selection.slice("model:".length)
            if (name !== "" && Object.hasOwn(aliases, name) && aliases[name] !== draft.original) { setInvalid(previous => ({ ...previous, group: true })); return }
            setDraft({ ...draft, name, members: name === "" || draft.members.includes(name) ? draft.members : [...draft.members, name] })
            setInvalid(previous => ({ ...previous, name: false, group: false }))
          }} disabled={disabled} />}
          <Field data-invalid={invalid.name} data-disabled={disabled}><FieldLabel htmlFor="model-display-name">{t("modelDisplay.name")}</FieldLabel><Input id="model-display-name" value={draft.name} maxLength={120} placeholder="deepseek-flash" aria-invalid={invalid.name} aria-describedby={invalid.name ? "model-display-error" : undefined} disabled={disabled} onChange={event => { setDraft({ ...draft, name: event.target.value }); setInvalid(previous => ({ ...previous, name: false, group: false })) }} /></Field>
          {candidates.size > 0 && <ManagedSelect label={t("modelDisplay.chooseMember")} value="" placeholder={t("modelDisplay.chooseMember")} options={[...candidates].filter(([id]) => !draft.members.includes(id)).map(([id, label]) => [id, label] as [string, string])} onChange={id => { if (id) addMember(id) }} disabled={disabled} />}
          <Field data-invalid={invalid.member} data-disabled={disabled}><FieldLabel htmlFor="model-display-member">{t("modelDisplay.memberId")}</FieldLabel><Input id="model-display-member" value={member} maxLength={265} placeholder="cline-pass/deepseek-v4.1-flash" aria-invalid={invalid.member} aria-describedby={invalid.member ? "model-display-member-hint model-display-error" : "model-display-member-hint"} disabled={disabled} onChange={event => { setMember(event.target.value); setInvalid(previous => ({ ...previous, member: false })) }} /><FieldDescription id="model-display-member-hint">{t("modelDisplay.memberHint")}</FieldDescription><Button className="self-start" variant="outline" disabled={disabled || member === ""} onClick={() => addMember(member, true)}>{t("modelDisplay.addMember")}</Button></Field>
          <Field><FieldLabel>{t("modelDisplay.members")}</FieldLabel>{draft.members.map(model => <div key={model} className="flex items-center gap-2"><span className="min-w-0 flex-1 break-all">{model}</span><Button size="sm" variant="outline" disabled={disabled} aria-label={t("modelDisplay.removeMember", { model })} onClick={() => { setDraft({ ...draft, members: draft.members.filter(id => id !== model) }); setInvalid(previous => ({ ...previous, member: member === model ? false : previous.member, group: false })) }}>{t("modelManagement.remove")}</Button></div>)}</Field>
          {(invalid.name || invalid.member || invalid.group) && <Alert variant="destructive"><AlertDescription id="model-display-error">{t("modelDisplay.invalid")}</AlertDescription></Alert>}
          {stale && <Alert variant="destructive"><AlertDescription>{t("modelDisplay.stale")}</AlertDescription></Alert>}
          {management.actionError && <Alert variant="destructive"><AlertDescription>{management.actionError}</AlertDescription></Alert>}
        </FieldGroup>}
        <DialogFooter><Button variant="outline" disabled={management.saving} onClick={() => setDraft(null)}>{t("modelManagement.cancel")}</Button><Button disabled={disabled || stale || !draft?.name || draft.members.length === 0 || member !== ""} onClick={preview}>{t("modelManagement.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
