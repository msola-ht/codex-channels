import { useState } from "react"
import { Link } from "react-router"
import { useRelayManagement } from "@/hooks/use-relay-management"
import { useTranslation } from "@/hooks/use-translation"
import type { RelayManagedCaller, RelayManagementInput, RelayManagementResult, RelayReasoning } from "@/lib/types"
import { translateApiError } from "@/lib/i18n/translate"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel, FieldDescription } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetFooter } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorBanner } from "@/components/metrics/error-banner"

export function RelayPage() {
  const { t } = useTranslation()
  const management = useRelayManagement()
  const [editing, setEditing] = useState<"new" | RelayManagedCaller | null>(null)
  const [caller, setCaller] = useState("")
  const [provider, setProvider] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [reasoning, setReasoning] = useState<RelayReasoning>("passthrough")
  const [result, setResult] = useState<RelayManagementResult | null>(null)
  const data = management.data
  const refreshingBlocked = management.busy || management.loading || management.pendingPreview !== null
  const blocked = refreshingBlocked || management.error !== null
  const selected = data?.providers.find(value => value.id === provider)
  const supportsOff = models.length > 0 && models.every(model => selected?.models.some(value => value.id === model && value.reasoningOff))
  const openEditor = (value: "new" | RelayManagedCaller) => {
    setEditing(value)
    setCaller(value === "new" ? "" : value.caller_id)
    setProvider(value === "new" ? "" : value.provider)
    setModels(value === "new" ? [] : value.models)
    setReasoning(value === "new" ? "passthrough" : value.reasoning)
    setResult(null)
  }
  const mutate = (input: RelayManagementInput) => {
    if (data) void management.mutate({ revision: data.revision, input })
  }
  const submit = () => {
    if (editing === "new") mutate({ command: "issue", caller, key: `key-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`, provider, models, reasoning })
    else mutate({ command: "edit", caller, models, reasoning })
  }
  const confirm = async () => {
    const saved = await management.confirm()
    if (saved) { setResult(saved); setEditing(null) }
  }
  const preview = management.pendingPreview?.preview
  const previewCaller = preview?.callers[0]
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h1 className="text-xl font-semibold">{t("relay.title")}</h1><p className="text-sm text-muted-foreground">{t("relay.description")}</p></div>
      <div className="flex gap-2"><Button variant="outline" disabled={refreshingBlocked} onClick={management.refetch}>{t("relay.refresh")}</Button><Button disabled={blocked || !data} onClick={() => openEditor("new")}>{t("relay.create")}</Button></div>
    </div>
    <ErrorBanner error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />
    <ErrorBanner error={management.actionError ? translateApiError(t, management.actionError, management.actionErrorCode) : null} />
    {data && <p className="text-sm text-muted-foreground">{t(data.enabled ? "relay.configEnabled" : "relay.configDisabled")} <Link to="/settings" className="underline">{t("relay.providers")}</Link></p>}
    {management.loading && <p>{t("common.loading")}</p>}
    {data && <Table><TableHeader><TableRow>
      {(["purpose", "provider", "models", "reasoning", "status", "actions"] as const).map(column => <TableHead key={column}>{t(`relay.${column}`)}</TableHead>)}
    </TableRow></TableHeader><TableBody>
      {data.callers.map(entry => <TableRow key={entry.key_id}>
        <TableCell><div>{entry.caller_id}</div><div className="text-xs text-muted-foreground">{entry.key_id} · {t("relay.generation", { value: entry.credential_generation })}</div></TableCell>
        <TableCell>{entry.provider}</TableCell><TableCell className="max-w-72 break-all">{entry.models.join(", ")}</TableCell>
        <TableCell>{t(entry.reasoning === "off" ? "relay.off" : "relay.passthrough")}</TableCell><TableCell>{t(entry.enabled ? "relay.enabled" : "relay.disabled")}</TableCell>
        <TableCell><div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={blocked} onClick={() => openEditor(entry)}>{t("relay.edit")}</Button>
          <Button size="sm" variant="outline" disabled={blocked} onClick={() => mutate({ command: "rotate", caller: entry.caller_id })}>{t("relay.rotate")}</Button>
          <Button size="sm" variant="outline" disabled={blocked || !entry.enabled} onClick={() => mutate({ command: "disable", caller: entry.caller_id })}>{t("relay.disable")}</Button>
          <Button size="sm" variant="ghost" asChild><Link to={`/requests?source=relay&callerId=${encodeURIComponent(entry.caller_id)}`}>{t("relay.requests")}</Link></Button>
        </div></TableCell>
      </TableRow>)}
      {!data.callers.length && <TableRow><TableCell colSpan={6}>{t("relay.empty")}</TableCell></TableRow>}
    </TableBody></Table>}
    <Sheet open={editing !== null && !preview} onOpenChange={open => { if (!open && !management.busy) setEditing(null) }}>
      <SheetContent className="sm:max-w-xl" closeLabel={t("relay.close")}><SheetHeader><SheetTitle>{t(editing === "new" ? "relay.create" : "relay.edit")}</SheetTitle><SheetDescription>{t("relay.formHint")}</SheetDescription></SheetHeader>
        <FieldGroup className="overflow-y-auto px-4">
          <ErrorBanner error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />
          <ErrorBanner error={management.actionError ? translateApiError(t, management.actionError, management.actionErrorCode) : null} />
          {(management.error || management.actionError) && <Button variant="outline" disabled={refreshingBlocked} onClick={management.refetch}>{t("relay.refresh")}</Button>}
          <Field><FieldLabel htmlFor="relay-caller">{t("relay.purpose")}</FieldLabel><Input id="relay-caller" value={caller} disabled={editing !== "new" || management.busy} onChange={event => setCaller(event.target.value)} maxLength={64} /><FieldDescription>{t("relay.purposeHint")}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="relay-provider">{t("relay.provider")}</FieldLabel><Select value={provider} disabled={editing !== "new" || management.busy} onValueChange={value => { setProvider(value); setModels([]) }}><SelectTrigger id="relay-provider"><SelectValue placeholder={t("relay.chooseProvider")} /></SelectTrigger><SelectContent><SelectGroup>{data?.providers.map(value => <SelectItem key={value.id} value={value.id} disabled={!value.available}>{value.id}{value.available ? "" : ` (${t("relay.unavailable")})`}</SelectItem>)}</SelectGroup></SelectContent></Select></Field>
          <Field><FieldLabel>{t("relay.models")}</FieldLabel><div className="flex max-h-48 flex-col gap-2 overflow-y-auto">{[...new Set([...(selected?.models.map(value => value.id) ?? []), ...models])].map(model => <Field key={model} orientation="horizontal"><Checkbox id={`model-${model}`} checked={models.includes(model)} disabled={management.busy} onCheckedChange={checked => setModels(values => checked ? [...values, model] : values.filter(value => value !== model))} /><FieldLabel htmlFor={`model-${model}`}>{model}</FieldLabel></Field>)}</div></Field>
          <Field><FieldLabel htmlFor="relay-reasoning">{t("relay.reasoning")}</FieldLabel><Select value={reasoning} disabled={management.busy} onValueChange={value => setReasoning(value as RelayReasoning)}><SelectTrigger id="relay-reasoning"><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="passthrough">{t("relay.passthrough")}</SelectItem><SelectItem value="off" disabled={!supportsOff}>{t("relay.off")}</SelectItem></SelectGroup></SelectContent></Select><FieldDescription>{t(supportsOff ? "relay.offHint" : "relay.unsupported")}</FieldDescription></Field>
        </FieldGroup>
        <SheetFooter><Button variant="outline" disabled={management.busy} onClick={() => setEditing(null)}>{t("relay.cancel")}</Button><Button disabled={blocked || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(caller) || !selected?.available || !models.length || reasoning === "off" && !supportsOff} onClick={submit}>{t("relay.preview")}</Button></SheetFooter>
      </SheetContent>
    </Sheet>
    <Sheet open={preview !== undefined} onOpenChange={open => { if (!open) management.cancel() }}><SheetContent className="sm:max-w-xl" closeLabel={t("relay.close")}><SheetHeader><SheetTitle>{t("relay.confirm")}</SheetTitle><SheetDescription>{t("relay.confirmHint")}</SheetDescription></SheetHeader>
      {preview && <div className="flex flex-col gap-2"><p>{t(`relay.operation.${preview.command}`)} · {preview.caller}</p>{previewCaller && <><p>{previewCaller.provider} · {previewCaller.models.join(", ")}</p><p>{t(previewCaller.reasoning === "off" ? "relay.off" : "relay.passthrough")}</p></>}</div>}
      <SheetFooter><Button variant="outline" disabled={management.busy} onClick={management.cancel}>{t("relay.cancel")}</Button><Button disabled={management.busy} onClick={() => void confirm()}>{t("relay.confirm")}</Button></SheetFooter>
    </SheetContent></Sheet>
    <Sheet open={result !== null} onOpenChange={open => { if (!open) setResult(null) }}><SheetContent className="sm:max-w-xl" closeLabel={t("relay.close")}><SheetHeader><SheetTitle>{t("relay.saved")}</SheetTitle><SheetDescription>{result ? t(`relay.${result.activation}`) : ""}</SheetDescription></SheetHeader>
      {result?.key && <Field><FieldLabel htmlFor="relay-secret">{t("relay.secret")}</FieldLabel><Input id="relay-secret" readOnly value={result.key} onFocus={event => event.target.select()} /><FieldDescription>{t("relay.secretHint")}</FieldDescription></Field>}
      {result?.cleanupStatus === "failed" && <p role="alert">{t("relay.cleanupFailed")}</p>}
      {result?.auditStatus === "failed" && <p role="alert">{t("relay.auditFailed")}</p>}
      <SheetFooter><Button onClick={() => setResult(null)}>{t("relay.close")}</Button></SheetFooter>
    </SheetContent></Sheet>
  </div>
}
