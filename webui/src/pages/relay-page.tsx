import { RelayKeyModels } from "@/components/settings/relay-key-models"
import { RelayModelCopy } from "@/components/settings/relay-model-copy"
import { useRef, useState } from "react"
import { Link } from "react-router"
import { MoreHorizontalIcon } from "lucide-react"
import { RelayProviderModels } from "@/components/settings/relay-provider-models"
import { RelayServiceManagement } from "@/components/settings/relay-service-management"
import { useRelayServiceManagement } from "@/hooks/use-relay-service-management"
import { useRelayManagement } from "@/hooks/use-relay-management"
import { useTranslation } from "@/hooks/use-translation"
import type { RelayManagedCaller, RelayManagementInput, RelayManagementResult, RelayReasoning } from "@/lib/types"
import { translateApiError } from "@/lib/i18n/translate"
import { formatTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from "@/components/ui/field"
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
  const cancelRef = useRef<HTMLButtonElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const pageHeading = useRef<HTMLHeadingElement | null>(null)
  const [name, setName] = useState("")
  const [caller, setCaller] = useState("")
  const [models, setModels] = useState<string[]>([])
  const [reasoning, setReasoning] = useState<RelayReasoning>("passthrough")
  const [removedModelCount, setRemovedModelCount] = useState(0)
  const [result, setResult] = useState<RelayManagementResult | null>(null)
  const data = management.data
  const snapshotCurrent = !management.loading && management.error === null
  const refreshingBlocked = management.busy || management.loading || management.pendingPreview !== null
  const serviceManagement = useRelayServiceManagement(management.refetch, refreshingBlocked)
  const blocked = refreshingBlocked || management.error !== null
  const nameInvalid = [...name].length < 1 || [...name].length > 64 || name.trim() !== name || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)
  const draftStale = editing !== null && data !== null && draftRevision !== data.revision
  const latestCaller = editing && editing !== "new" ? data?.callers.find(value => value.caller_id === editing.caller_id) : undefined
  const modelsChanged = editing === "new" || editing === null || JSON.stringify(models) !== JSON.stringify(editing.models)
  const selectedModelsAvailable = models.every(id => data?.providers.some(provider => provider.available && provider.models.some(model => model.relayId === id)))
  const offModelIds = new Set(data?.providers.filter(provider => provider.available).flatMap(provider => provider.models.filter(model => model.reasoningOff).map(model => model.relayId)) ?? [])
  const selectedModelsSupportOff = reasoning !== "off" || models.every(id => offModelIds.has(id))
  const changeReasoning = (value: RelayReasoning, selected = models) => {
    const next = value === "off" ? selected.filter(id => offModelIds.has(id)) : selected
    setRemovedModelCount(selected.length - next.length)
    setModels(next)
    setReasoning(value)
  }
  const openEditor = (value: "new" | RelayManagedCaller, discardDraft = false) => {
    if (!data || blocked) return
    if (!discardDraft) returnFocus.current = document.activeElement as HTMLElement
    setDraftRevision(data.revision)
    management.clearError()
    setEditing(value)
    setName(value === "new" ? "" : value.display_name ?? value.caller_id)
    setCaller(value === "new" ? `client-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}` : value.caller_id)
    changeReasoning(value === "new" ? "passthrough" : value.reasoning, value === "new" ? [] : [...value.models])
    setResult(null)
  }
  const mutate = (input: RelayManagementInput, revision = data?.revision) => {
    if (revision) void management.mutate({ revision, input })
  }
  const submit = () => {
    if (blocked || draftStale || !draftRevision || editing === null || !models.length || !selectedModelsSupportOff) return
    if (editing === "new") mutate({ command: "issue", caller, name, key: `key-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("")}`, models, reasoning }, draftRevision)
    else mutate({ command: "edit", caller, name, models, reasoning }, draftRevision)
  }
  const confirm = async () => {
    const saved = await management.confirm()
    if (saved) { setResult(saved); setEditing(null) }
  }
  const preview = management.pendingPreview?.preview
  const previewCaller = preview?.callers[0]
  const restoreFocus = () => {
    if (editing === null && preview === undefined && result === null) {
      const target = returnFocus.current
      return target?.isConnected && !target.matches(":disabled") ? target : pageHeading.current
    }
    return false
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
    {data && <RelayProviderModels snapshot={data} blocked={blocked} refreshBlocked={refreshingBlocked} onRefresh={management.refetch} error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />}
    {management.loading && <div role="status" aria-label={t("common.loading")}><Skeleton className="h-24 w-full" /></div>}
    {data && !management.loading && !management.error && <Card><CardHeader><CardTitle>{t("relay.keysTitle")}</CardTitle><CardDescription>{t("relay.keysHint")}</CardDescription></CardHeader><CardContent className="min-w-0"><Table><TableHeader><TableRow>
      {(["purpose", "provider", "protocol", "reasoning", "generationLabel", "status", "lastRequest", "recentRequests", "actions"] as const).map(column => <TableHead key={column}>{t(`relay.${column}`)}</TableHead>)}
    </TableRow></TableHeader><TableBody>
      {data.callers.map(entry => {
        const providers = [...new Set(entry.models.map(id => id.slice(0, id.indexOf("/"))))]
        const protocols = [...new Set(data.providers.filter(value => providers.includes(value.id)).flatMap(value => value.protocols ?? []))]
        const usage = data.usage?.callers.find(value => value.callerId === entry.caller_id && value.keyId === entry.key_id)
        return <TableRow key={entry.key_id}>
        <TableCell className="min-w-40 max-w-60 whitespace-normal"><div className="break-all">{entry.display_name ?? entry.caller_id}</div></TableCell>
        <TableCell className="max-w-40 whitespace-normal break-all">{providers.join(", ")}</TableCell>
        <TableCell><div className="flex flex-wrap gap-1">{protocols?.length
          ? protocols.map(protocol => <Badge key={protocol} variant="outline">{protocol === "chat" ? "Chat" : "Responses"}</Badge>)
          : <Badge variant="outline">{t("relay.capabilityUnknown")}</Badge>}</div></TableCell>
        <TableCell>{t(entry.reasoning === "off" ? "relay.keyOff" : "relay.passthrough")}</TableCell><TableCell className="tabular-nums">{entry.credential_generation}</TableCell><TableCell><Badge variant={entry.enabled ? "secondary" : "outline"}>{t(entry.enabled ? "relay.enabled" : "relay.disabled")}</Badge></TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{!usage ? t("relay.usageUnknown") : usage.lastRequestAtMs === null ? t("relay.noRecordedRequests") : formatTime(usage.lastRequestAtMs)}</TableCell>
        <TableCell className="whitespace-nowrap tabular-nums">{!usage ? t("relay.usageUnknown") : <div className="flex flex-col gap-1"><span>{t("relay.requestCount", { count: usage.requestCount })}</span><span className={usage.unsuccessfulRequestCount > 0 ? "text-destructive" : "text-muted-foreground"}>{t("relay.unsuccessfulCount", { count: usage.unsuccessfulRequestCount })}</span></div>}</TableCell>
        <TableCell className="w-px whitespace-nowrap"><div className="flex items-center gap-1">
          <Button size="xs" variant="ghost" disabled={blocked} onClick={() => openEditor(entry)}>{t("relay.edit")}</Button>
          <Button size="xs" variant="ghost" render={<Link to={`/requests?source=relay&callerId=${encodeURIComponent(entry.caller_id)}`} />} nativeButton={false}>{t("relay.requests")}</Button>
          <RelayModelCopy models={entry.models} />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button id={`relay-actions-${entry.caller_id}`} size="icon-xs" variant="ghost" disabled={blocked} aria-label={t("relay.moreActions", { name: entry.display_name ?? entry.caller_id })} />}><MoreHorizontalIcon /></DropdownMenuTrigger>
            <DropdownMenuContent align="end"><DropdownMenuGroup>
              <DropdownMenuItem disabled={blocked} onClick={() => startAction({ command: "rotate", caller: entry.caller_id })}>{t("relay.rotate")}</DropdownMenuItem>
              <DropdownMenuItem disabled={blocked || !entry.enabled} onClick={() => startAction({ command: "disable", caller: entry.caller_id })}>{t("relay.disable")}</DropdownMenuItem>
            </DropdownMenuGroup><DropdownMenuSeparator /><DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" disabled={blocked} onClick={() => startAction({ command: "delete", caller: entry.caller_id })}>{t("relay.delete")}</DropdownMenuItem>
            </DropdownMenuGroup></DropdownMenuContent>
          </DropdownMenu>
        </div></TableCell>
      </TableRow>})}
      {!data.callers.length && <TableRow><TableCell colSpan={9}><Empty><EmptyHeader><EmptyDescription>{t("relay.empty")}</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>}
    </TableBody></Table></CardContent></Card>}
    <Dialog open={editing !== null && !preview} disablePointerDismissal onOpenChange={(open, details) => { if (management.busy) { details.cancel(); return }; if (!open) setEditing(null) }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl" closeLabel={t("relay.close")} finalFocus={restoreFocus} showCloseButton={!management.busy}><DialogHeader className="pr-8"><DialogTitle>{t(editing === "new" ? "relay.create" : "relay.edit")}</DialogTitle><DialogDescription>{t("relay.formHint")}</DialogDescription></DialogHeader>
        <FieldGroup className="min-h-0 overflow-y-auto px-1 py-1">
          <ErrorBanner error={management.error ? translateApiError(t, management.error, management.errorCode) : null} />
          <ErrorBanner error={management.actionError ? translateApiError(t, management.actionError, management.actionErrorCode) : null} />
          {(management.error || management.actionError) && <Button variant="outline" disabled={serviceManagement.refreshBlocked} onClick={serviceManagement.refresh}>{t("relay.refresh")}</Button>}
          {draftStale && !management.loading && !management.error && <Alert><AlertDescription>{t(editing !== "new" && !latestCaller ? "relay.callerRemoved" : "relay.draftStale")}</AlertDescription></Alert>}
          {draftStale && (editing === "new" || latestCaller) && <Button variant="outline" disabled={blocked} onClick={() => { if (editing === "new") openEditor("new", true); else if (latestCaller) openEditor(latestCaller, true) }}>{t("relay.reloadDraft")}</Button>}
          <Field data-invalid={name.length > 0 && nameInvalid} data-disabled={management.busy}><FieldLabel htmlFor="relay-name">{t("relay.purpose")}</FieldLabel>{editing === "new" && <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[name]} disabled={management.busy} aria-label={t("relay.purposePresetsLabel")} onValueChange={([value]) => { if (value) setName(value) }}>
            {(["translation", "coding", "chat", "writing", "testing"] as const).map(preset => <ToggleGroupItem key={preset} value={t(`relay.purposePresets.${preset}`)}>{t(`relay.purposePresets.${preset}`)}</ToggleGroupItem>)}
          </ToggleGroup>}<Input id="relay-name" value={name} disabled={management.busy} onChange={event => setName(event.target.value)} aria-invalid={name.length > 0 && nameInvalid} aria-describedby={name.length > 0 && nameInvalid ? "relay-name-hint relay-name-error" : "relay-name-hint"} /><FieldDescription id="relay-name-hint">{t("relay.purposeHint")}</FieldDescription>{name.length > 0 && nameInvalid && <FieldError id="relay-name-error">{t("relay.nameInvalid")}</FieldError>}{editing !== "new" && <FieldDescription>{t("relay.callerId")}: {caller}</FieldDescription>}</Field>
          {removedModelCount > 0 && <Alert><AlertDescription>{t("relay.offModelsRemoved", { count: removedModelCount })}</AlertDescription></Alert>}
          <RelayKeyModels providers={data?.providers ?? []} models={models} reasoning={reasoning} disabled={management.busy || draftStale} onChange={setModels} />
          <Field data-disabled={management.busy}><FieldLabel id="relay-reasoning-label">{t("relay.reasoning")}</FieldLabel><ToggleGroup variant="outline" value={[reasoning]} disabled={management.busy || draftStale} aria-labelledby="relay-reasoning-label" aria-describedby="relay-reasoning-hint" onValueChange={([value]) => { if (value === "passthrough" || value === "off") changeReasoning(value) }}><ToggleGroupItem value="passthrough">{t("relay.passthrough")}</ToggleGroupItem><ToggleGroupItem value="off">{t("relay.keyOff")}</ToggleGroupItem></ToggleGroup><FieldDescription id="relay-reasoning-hint">{t("relay.offHint")}</FieldDescription></Field>
        </FieldGroup>
        <DialogFooter><Button variant="outline" disabled={management.busy} onClick={() => setEditing(null)}>{t("relay.cancel")}</Button><Button disabled={blocked || draftStale || nameInvalid || !models.length || !selectedModelsSupportOff || modelsChanged && !selectedModelsAvailable} onClick={submit}>{management.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <AlertDialog open={preview !== undefined} onOpenChange={(open, details) => { if (management.busy) { details.cancel(); return }; if (!open) management.cancel() }}>
      <AlertDialogContent initialFocus={cancelRef} className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-lg" finalFocus={restoreFocus}>
        <AlertDialogHeader><AlertDialogTitle>{preview ? t(`relay.operation.${preview.command}`) : t("relay.confirm")}</AlertDialogTitle><AlertDialogDescription>{preview ? t(`relay.confirmHints.${preview.command}`) : ""}</AlertDialogDescription></AlertDialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {preview && <dl className="grid min-w-0 gap-3"><div><dt className="text-muted-foreground">{t("relay.purpose")}</dt><dd className="break-words">{previewCaller?.display_name ?? preview.caller}</dd></div><div><dt className="text-muted-foreground">{t("relay.callerId")}</dt><dd className="break-all">{preview.caller}</dd></div>{previewCaller && <><div><dt className="text-muted-foreground">{t("relay.provider")}</dt><dd className="break-all">{[...new Set(previewCaller.models.map(id => id.slice(0, id.indexOf("/"))))].join(", ")}</dd></div>{preview.command !== "delete" && <div><dt className="text-muted-foreground">{t("relay.models")}</dt><dd className="break-all">{previewCaller.models.join(", ")}</dd></div>}<div><dt className="text-muted-foreground">{t("relay.reasoning")}</dt><dd>{t(previewCaller.reasoning === "off" ? "relay.keyOff" : "relay.passthrough")}</dd></div></>}</dl>}
        </div>
        <AlertDialogFooter><AlertDialogCancel ref={cancelRef} disabled={management.busy}>{t("relay.cancel")}</AlertDialogCancel><AlertDialogAction variant={(preview?.command === "disable" || preview?.command === "delete") ? "destructive" : "default"} disabled={management.busy} onClick={event => { event.preventDefault(); void confirm() }}>{management.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.confirm")}</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    <Dialog open={result !== null} disablePointerDismissal onOpenChange={(open, details) => { if (management.busy) { details.cancel(); return }; if (!open) setResult(null) }}><DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl" closeLabel={t("relay.close")} finalFocus={restoreFocus} showCloseButton={!management.busy}><DialogHeader className="pr-8"><DialogTitle>{t("relay.saved")}</DialogTitle><DialogDescription>{result ? t(`relay.${result.activation}`) : ""}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
      {result?.key && <Field><FieldLabel htmlFor="relay-secret">{t("relay.secret")}</FieldLabel><Input id="relay-secret" readOnly value={result.key} onFocus={event => event.target.select()} /><FieldDescription>{t("relay.secretHint")}</FieldDescription></Field>}
      {result?.cleanupStatus === "failed" && <Alert><AlertDescription>{t("relay.cleanupFailed")}</AlertDescription></Alert>}
      {result?.auditStatus === "failed" && <Alert><AlertDescription>{t("relay.auditFailed")}</AlertDescription></Alert>}
      </div>
      <DialogFooter><Button onClick={() => setResult(null)}>{t("relay.close")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>
}
