import { useRef, useState } from "react"
import { Link } from "react-router"
import { MoreHorizontalIcon } from "lucide-react"
import { RelayServiceManagement } from "@/components/settings/relay-service-management"
import { useRelayServiceManagement } from "@/hooks/use-relay-service-management"
import { useRelayManagement } from "@/hooks/use-relay-management"
import { useTranslation } from "@/hooks/use-translation"
import type { RelayManagedCaller, RelayManagementInput, RelayManagementResult, RelayReasoning } from "@/lib/types"
import { translateApiError } from "@/lib/i18n/translate"
import { formatTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError, FieldSet, FieldLegend } from "@/components/ui/field"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"

export function RelayPage() {
  const { t } = useTranslation()
  const management = useRelayManagement()
  const [editing, setEditing] = useState<"new" | RelayManagedCaller | null>(null)
  const [draftRevision, setDraftRevision] = useState<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const pageHeading = useRef<HTMLHeadingElement | null>(null)
  const [name, setName] = useState("")
  const [caller, setCaller] = useState("")
  const [provider, setProvider] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [reasoning, setReasoning] = useState<RelayReasoning>("passthrough")
  const [result, setResult] = useState<RelayManagementResult | null>(null)
  const data = management.data
  const snapshotCurrent = !management.loading && management.error === null
  const refreshingBlocked = management.busy || management.loading || management.pendingPreview !== null
  const serviceManagement = useRelayServiceManagement(management.refetch, refreshingBlocked)
  const blocked = refreshingBlocked || management.error !== null
  const nameInvalid = [...name].length < 1 || [...name].length > 64 || name.trim() !== name || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)
  const selected = data?.providers.find(value => value.id === provider)
  const capabilityUnavailable = provider !== "" && selected?.available !== true
  const draftStale = editing !== null && data !== null && draftRevision !== data.revision
  const latestCaller = editing && editing !== "new" ? data?.callers.find(value => value.caller_id === editing.caller_id) : undefined
  const supportsOff = models.length > 0 && models.every(model => selected?.models.some(value => value.id === model && value.reasoningOff))
  const policyChanged = editing === "new" || editing === null || reasoning !== editing.reasoning
    || provider !== editing.provider || models.length !== editing.models.length || models.some(model => !editing.models.includes(model))
  const openEditor = (value: "new" | RelayManagedCaller, discardDraft = false) => {
    if (!data || blocked) return
    if (!discardDraft) returnFocus.current = document.activeElement as HTMLElement
    setDraftRevision(data.revision)
    management.clearError()
    setEditing(value)
    setName(value === "new" ? "" : value.display_name ?? value.caller_id)
    setCaller(value === "new" ? `client-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}` : value.caller_id)
    setProvider(value === "new" ? "" : value.provider)
    setModels(value === "new" ? [] : value.models)
    setReasoning(value === "new" ? "passthrough" : value.reasoning)
    setResult(null)
  }
  const mutate = (input: RelayManagementInput, revision = data?.revision) => {
    if (revision) void management.mutate({ revision, input })
  }
  const submit = () => {
    if (blocked || draftStale || !draftRevision || editing === null) return
    if (editing === "new") mutate({ command: "issue", caller, name, key: `key-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`, provider, models, reasoning }, draftRevision)
    else mutate({ command: "edit", caller, name, provider, models, reasoning }, draftRevision)
  }
  const confirm = async () => {
    const saved = await management.confirm()
    if (saved) { setResult(saved); setEditing(null) }
  }
  const preview = management.pendingPreview?.preview
  const previewCaller = preview?.callers[0]
  const restoreFocus = (event: Event) => {
    event.preventDefault()
    if (editing === null && preview === undefined && result === null) {
      const target = returnFocus.current
      if (target?.isConnected && !target.matches(":disabled")) target.focus()
      else pageHeading.current?.focus()
    }
  }
  const startAction = (input: RelayManagementInput) => {
    returnFocus.current = document.getElementById(`relay-actions-${input.caller}`)
    mutate(input)
  }
  return <div className="flex min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h1 ref={pageHeading} tabIndex={-1} className="text-xl font-semibold">{t("relay.title")}</h1><p className="text-sm text-muted-foreground">{t("relay.description")}</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={serviceManagement.refreshBlocked} onClick={serviceManagement.refresh}>{t("relay.refresh")}</Button><Button disabled={blocked || !data} onClick={() => openEditor("new")}>{t("relay.create")}</Button></div>
    </div>
    <ErrorBanner error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />
    <ErrorBanner error={management.actionError ? translateApiError(t, management.actionError, management.actionErrorCode) : null} />
    <RelayServiceManagement controller={serviceManagement} snapshot={data} loading={management.loading} current={snapshotCurrent} />
    {management.loading && <div role="status" aria-label={t("common.loading")}><Skeleton className="h-24 w-full" /></div>}
    {data && !management.loading && !management.error && <Card><CardHeader><CardTitle>{t("relay.keysTitle")}</CardTitle><CardDescription>{t("relay.keysHint")}</CardDescription></CardHeader><CardContent className="min-w-0"><Table><TableHeader><TableRow>
      {(["purpose", "provider", "protocol", "models", "reasoning", "generationLabel", "status", "lastRequest", "recentRequests", "actions"] as const).map(column => <TableHead key={column}>{t(`relay.${column}`)}</TableHead>)}
    </TableRow></TableHeader><TableBody>
      {data.callers.map(entry => {
        const protocols = data.providers.find(value => value.id === entry.provider)?.protocols
        const usage = data.usage?.callers.find(value => value.callerId === entry.caller_id && value.keyId === entry.key_id)
        return <TableRow key={entry.key_id}>
        <TableCell className="min-w-40 max-w-60 whitespace-normal"><div className="break-all">{entry.display_name ?? entry.caller_id}</div></TableCell>
        <TableCell className="max-w-40 whitespace-normal break-all">{entry.provider}</TableCell>
        <TableCell><div className="flex flex-wrap gap-1">{protocols?.length
          ? protocols.map(protocol => <Badge key={protocol} variant="outline">{protocol === "chat" ? "Chat" : "Responses"}</Badge>)
          : <Badge variant="outline">{t("relay.capabilityUnknown")}</Badge>}</div></TableCell><TableCell className="max-w-72 whitespace-normal break-all"><ul className="flex flex-col gap-1">{entry.models.map(model => <li key={model}>{model}</li>)}</ul></TableCell>
        <TableCell>{t(entry.reasoning === "off" ? "relay.off" : "relay.passthrough")}</TableCell><TableCell className="tabular-nums">{entry.credential_generation}</TableCell><TableCell><Badge variant={entry.enabled ? "secondary" : "outline"}>{t(entry.enabled ? "relay.enabled" : "relay.disabled")}</Badge></TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{!usage ? t("relay.usageUnknown") : usage.lastRequestAtMs === null ? t("relay.noRecordedRequests") : formatTime(usage.lastRequestAtMs)}</TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{!usage ? t("relay.usageUnknown") : <div className="flex flex-col gap-1"><span>{t("relay.requestCount", { count: usage.requestCount })}</span><span className={usage.unsuccessfulRequestCount > 0 ? "text-destructive" : "text-muted-foreground"}>{t("relay.unsuccessfulCount", { count: usage.unsuccessfulRequestCount })}</span></div>}</TableCell>
        <TableCell className="w-px whitespace-nowrap"><div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" disabled={blocked} onClick={() => openEditor(entry)}>{t("relay.edit")}</Button>
          <Button size="xs" variant="ghost" asChild><Link to={`/requests?source=relay&callerId=${encodeURIComponent(entry.caller_id)}`}>{t("relay.requests")}</Link></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button id={`relay-actions-${entry.caller_id}`} size="icon-xs" variant="ghost" disabled={blocked} aria-label={t("relay.moreActions", { name: entry.display_name ?? entry.caller_id })}><MoreHorizontalIcon /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuGroup>
              <DropdownMenuItem disabled={blocked} onSelect={() => startAction({ command: "rotate", caller: entry.caller_id })}>{t("relay.rotate")}</DropdownMenuItem>
              <DropdownMenuItem disabled={blocked || !entry.enabled} onSelect={() => startAction({ command: "disable", caller: entry.caller_id })}>{t("relay.disable")}</DropdownMenuItem>
            </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" disabled={blocked} onSelect={() => startAction({ command: "delete", caller: entry.caller_id })}>{t("relay.delete")}</DropdownMenuItem>
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
        </div></TableCell>
      </TableRow>})}
      {!data.callers.length && <TableRow><TableCell colSpan={10}><Empty><EmptyHeader><EmptyDescription>{t("relay.empty")}</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>}
    </TableBody></Table></CardContent></Card>}
    <Dialog open={editing !== null && !preview} onOpenChange={open => { if (!open && !management.busy) setEditing(null) }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl" closeLabel={t("relay.close")} onCloseAutoFocus={restoreFocus} showCloseButton={!management.busy} onEscapeKeyDown={event => { if (management.busy) event.preventDefault() }} onInteractOutside={event => event.preventDefault()}><DialogHeader className="pr-8"><DialogTitle>{t(editing === "new" ? "relay.create" : "relay.edit")}</DialogTitle><DialogDescription>{t("relay.formHint")}</DialogDescription></DialogHeader>
        <FieldGroup className="min-h-0 overflow-y-auto px-1 py-1">
          <ErrorBanner error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />
          <ErrorBanner error={management.actionError ? translateApiError(t, management.actionError, management.actionErrorCode) : null} />
          {(management.error || management.actionError) && <Button variant="outline" disabled={serviceManagement.refreshBlocked} onClick={serviceManagement.refresh}>{t("relay.refresh")}</Button>}
          {draftStale && !management.loading && !management.error && <Alert><AlertDescription>{t(editing !== "new" && !latestCaller ? "relay.callerRemoved" : "relay.draftStale")}</AlertDescription></Alert>}
          {draftStale && (editing === "new" || latestCaller) && <Button variant="outline" disabled={blocked} onClick={() => { if (editing === "new") openEditor("new", true); else if (latestCaller) openEditor(latestCaller, true) }}>{t("relay.reloadDraft")}</Button>}
          <Field data-invalid={name.length > 0 && nameInvalid} data-disabled={management.busy}><FieldLabel htmlFor="relay-name">{t("relay.purpose")}</FieldLabel>{editing === "new" && <ToggleGroup type="single" variant="outline" size="sm" className="max-w-full flex-wrap" value={name} disabled={management.busy} aria-label={t("relay.purposePresetsLabel")} onValueChange={value => { if (value) setName(value) }}>
            {(["translation", "coding", "chat", "writing", "testing"] as const).map(preset => <ToggleGroupItem key={preset} value={t(`relay.purposePresets.${preset}`)}>{t(`relay.purposePresets.${preset}`)}</ToggleGroupItem>)}
          </ToggleGroup>}<Input id="relay-name" value={name} disabled={management.busy} onChange={event => setName(event.target.value)} aria-invalid={name.length > 0 && nameInvalid} aria-describedby={name.length > 0 && nameInvalid ? "relay-name-hint relay-name-error" : "relay-name-hint"} /><FieldDescription id="relay-name-hint">{t("relay.purposeHint")}</FieldDescription>{name.length > 0 && nameInvalid && <FieldError id="relay-name-error">{t("relay.nameInvalid")}</FieldError>}{editing !== "new" && <FieldDescription>{t("relay.callerId")}: {caller}</FieldDescription>}</Field>
          <Field data-disabled={management.busy}><FieldLabel htmlFor="relay-provider">{t("relay.provider")}</FieldLabel><Select value={provider} disabled={management.busy} onValueChange={value => { setProvider(value); setModels([]); setReasoning("passthrough") }}><SelectTrigger id="relay-provider"><SelectValue placeholder={t("relay.chooseProvider")} /></SelectTrigger><SelectContent><SelectGroup>{data?.providers.map(value => <SelectItem key={value.id} value={value.id} disabled={!value.available}>{value.id}{value.available ? "" : ` (${t("relay.unavailable")})`}</SelectItem>)}</SelectGroup></SelectContent></Select>{selected?.protocols?.length ? <FieldDescription>{t("relay.protocols", { value: selected.protocols.map(value => value === "chat" ? "Chat Completions" : "Responses").join(" / ") })}</FieldDescription> : null}</Field>
          <FieldSet disabled={management.busy || capabilityUnavailable}><FieldLegend>{t("relay.models")}</FieldLegend><div className="flex max-h-48 flex-col gap-2 overflow-y-auto">{[...new Set([...(selected?.models.map(value => value.id) ?? []), ...models])].map(model => {
            const inputs = selected?.models.find(value => value.id === model)?.inputModalities
            return <Field key={model} orientation="horizontal"><Checkbox id={`model-${model}`} checked={models.includes(model)} disabled={management.busy || capabilityUnavailable} onCheckedChange={checked => setModels(values => checked ? [...values, model] : values.filter(value => value !== model))} /><FieldLabel className="min-w-0 flex-col items-start gap-1 break-all" htmlFor={`model-${model}`}><span>{model}</span><span className="flex flex-wrap gap-1" aria-label={t("relay.inputFormats")}>{inputs?.length
            ? inputs.map(modality => <Badge key={modality} variant="outline">{t(`relay.modalities.${modality}`)}</Badge>)
            : <Badge variant="outline">{t("relay.capabilityUnknown")}</Badge>}</span></FieldLabel></Field>})}</div>{!selected?.models.length && !capabilityUnavailable && <FieldDescription>{t("relay.selectModelsHint")}</FieldDescription>}</FieldSet>
          <Field data-disabled={management.busy || capabilityUnavailable} data-invalid={!capabilityUnavailable && reasoning === "off" && !supportsOff}><FieldLabel id="relay-reasoning-label">{t("relay.reasoning")}</FieldLabel><ToggleGroup type="single" variant="outline" value={reasoning} disabled={management.busy || capabilityUnavailable} aria-labelledby="relay-reasoning-label" aria-describedby="relay-reasoning-hint" onValueChange={value => { if (value === "passthrough" || value === "off") setReasoning(value) }}><ToggleGroupItem value="passthrough">{t("relay.passthrough")}</ToggleGroupItem><ToggleGroupItem value="off" disabled={!supportsOff}>{t("relay.off")}</ToggleGroupItem></ToggleGroup><FieldDescription id="relay-reasoning-hint">{t(capabilityUnavailable ? "relay.capabilityUnavailable" : !provider || !models.length ? "relay.selectModelsHint" : supportsOff ? "relay.offHint" : "relay.unsupported")}</FieldDescription></Field>
        </FieldGroup>
        <DialogFooter><Button variant="outline" disabled={management.busy} onClick={() => setEditing(null)}>{t("relay.cancel")}</Button><Button disabled={blocked || draftStale || nameInvalid || policyChanged && (!selected?.available || !models.length || reasoning === "off" && !supportsOff)} onClick={submit}>{management.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={preview !== undefined} onOpenChange={open => { if (!open) management.cancel() }}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg" onCloseAutoFocus={restoreFocus}>
        <AlertDialogHeader><AlertDialogTitle>{preview ? t(`relay.operation.${preview.command}`) : t("relay.confirm")}</AlertDialogTitle><AlertDialogDescription>{preview ? t(`relay.confirmHints.${preview.command}`) : ""}</AlertDialogDescription></AlertDialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {preview && <dl className="grid min-w-0 gap-3"><div><dt className="text-muted-foreground">{t("relay.purpose")}</dt><dd className="break-words">{previewCaller?.display_name ?? preview.caller}</dd></div><div><dt className="text-muted-foreground">{t("relay.callerId")}</dt><dd className="break-all">{preview.caller}</dd></div>{previewCaller && <><div><dt className="text-muted-foreground">{t("relay.provider")}</dt><dd className="break-all">{previewCaller.provider}</dd></div><div><dt className="text-muted-foreground">{t("relay.models")}</dt><dd className="break-all">{previewCaller.models.join(", ")}</dd></div><div><dt className="text-muted-foreground">{t("relay.reasoning")}</dt><dd>{t(previewCaller.reasoning === "off" ? "relay.off" : "relay.passthrough")}</dd></div></>}</dl>}
        </div>
        <AlertDialogFooter><AlertDialogCancel disabled={management.busy}>{t("relay.cancel")}</AlertDialogCancel><AlertDialogAction variant={(preview?.command === "disable" || preview?.command === "delete") ? "destructive" : "default"} disabled={management.busy} onClick={event => { event.preventDefault(); void confirm() }}>{management.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.confirm")}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={result !== null} onOpenChange={open => { if (!open) setResult(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl" closeLabel={t("relay.close")} onCloseAutoFocus={restoreFocus} showCloseButton={!management.busy} onEscapeKeyDown={event => { if (management.busy) event.preventDefault() }} onInteractOutside={event => event.preventDefault()}><DialogHeader className="pr-8"><DialogTitle>{t("relay.saved")}</DialogTitle><DialogDescription>{result ? t(`relay.${result.activation}`) : ""}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      {result?.key && <Field><FieldLabel htmlFor="relay-secret">{t("relay.secret")}</FieldLabel><Input id="relay-secret" readOnly value={result.key} onFocus={event => event.target.select()} /><FieldDescription>{t("relay.secretHint")}</FieldDescription></Field>}
      {result?.cleanupStatus === "failed" && <Alert><AlertDescription>{t("relay.cleanupFailed")}</AlertDescription></Alert>}
      {result?.auditStatus === "failed" && <Alert><AlertDescription>{t("relay.auditFailed")}</AlertDescription></Alert>}
      </div>
      <DialogFooter><Button onClick={() => setResult(null)}>{t("relay.close")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>
}
