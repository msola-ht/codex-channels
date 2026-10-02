import { useCallback, useEffect, useRef, useState } from "react"
import { CheckIcon } from "lucide-react"
import { formatTimestamp } from "@/lib/format"
import { updateRelayCatalog } from "@/lib/api"
import type { RelayExtraModel, RelayManagementSnapshot } from "@/lib/types"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Alert, AlertDescription } from "@/components/ui/alert"

interface Draft { revision: string; provider: string; enabledModels: string[]; extraModels: RelayExtraModel[] }

export function RelayExtraModels({ snapshot, blocked: parentBlocked, refreshBlocked = parentBlocked, confirmationOpen = false, error, onSubmit, onRefresh }: {
  snapshot: RelayManagementSnapshot
  blocked: boolean
  refreshBlocked?: boolean
  confirmationOpen?: boolean
  error?: string | null
  onRefresh?: () => void
  onSubmit: (provider: string, models: RelayExtraModel[], revision: string, enabledModels: string[]) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [downloading, setDownloading] = useState(false)
  const [downloadMessage, setDownloadMessage] = useState<"error" | "updated" | "auditFailed" | null>(null)
  const controller = useRef<AbortController | null>(null)
  const autoAttempted = useRef(false)
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  useEffect(() => () => { controller.current?.abort(); controller.current = null; autoAttempted.current = false }, [])
  const blocked = parentBlocked || downloading
  const closeBlocked = refreshBlocked || downloading
  const catalog = snapshot.clineCatalog?.status === "ready" ? snapshot.clineCatalog : null
  const download = useCallback(async () => {
    if (controller.current) return
    const active = new AbortController()
    controller.current = active
    setDownloading(true); setDownloadMessage(null)
    try {
      const result = await updateRelayCatalog(active.signal)
      if (!active.signal.aborted) { setDownloadMessage(result.auditStatus === "failed" ? "auditFailed" : "updated"); onRefresh?.() }
    } catch { if (!active.signal.aborted) setDownloadMessage("error") }
    finally { if (controller.current === active) controller.current = null; if (!active.signal.aborted) setDownloading(false) }
  }, [onRefresh])
  const hasCline = snapshot.providers.some(provider => provider.id.startsWith("clp-"))
  useEffect(() => {
    if (parentBlocked || !hasCline || snapshot.clineCatalog?.status !== "missing" || autoAttempted.current) return
    autoAttempted.current = true
    void download()
  }, [parentBlocked, hasCline, snapshot.clineCatalog?.status, download])
  const selected = snapshot.providers.find(provider => provider.id === draft?.provider)
  const stale = draft !== null && draft.revision !== snapshot.revision
  const open = (provider: RelayManagementSnapshot["providers"][number]) => setDraft({
    provider: provider.id, revision: snapshot.revision, enabledModels: [...provider.enabledModels], extraModels: structuredClone(provider.extraModels ?? []),
  })
  const setEnabled = (id: string, enabled: boolean) => setDraft(value => value ? { ...value,
    enabledModels: enabled ? [...new Set([...value.enabledModels, id])] : value.enabledModels.filter(model => model !== id),
  } : null)
  const setReasoning = (id: string, reasoning: RelayExtraModel["reasoning"]) => {
    if (reasoning === "passthrough") {
      setDraft(value => value ? { ...value, extraModels: value.extraModels.filter(model => model.id !== id) } : null)
      return
    }
    if (!catalog || !Object.hasOwn(catalog.efforts, id)) return
    const efforts = catalog.efforts[id] ?? []
    setDraft(value => value ? { ...value, extraModels: [...value.extraModels.filter(model => model.id !== id),
      { id, reasoning_efforts: efforts, reasoning }],
    } : null)
  }
  if (!snapshot.providers.length) return null
  return <>
    <Card>
      <CardHeader><CardTitle>{t("relay.extra.title")}</CardTitle><CardDescription>{t("relay.extra.listHint")}</CardDescription></CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Table aria-label={t("relay.extra.title")}>
          <TableHeader><TableRow><TableHead>{t("modelManagement.providers")}</TableHead><TableHead>{t("relay.extra.catalogColumn")}</TableHead><TableHead>{t("relay.extra.settingsColumn")}</TableHead><TableHead className="text-right">{t("modelManagement.actions")}</TableHead></TableRow></TableHeader>
          <TableBody>{snapshot.providers.map(provider => <TableRow key={provider.id}>
            <TableCell>{provider.id}</TableCell>
            <TableCell>{provider.id.startsWith("clp-") ? catalog ? <div className="flex flex-col gap-1"><span>{catalog.catalog.commit.slice(0, 12)}</span><span className="text-muted-foreground">{formatTimestamp(catalog.catalog.downloadedAt)}</span></div> : t("relay.catalog.unavailable") : t("relay.extra.providerCatalog")}</TableCell>
            <TableCell>{t("relay.extra.enabledCount", { enabled: provider.enabledModels?.length ?? 0, total: provider.models.length })}</TableCell>
            <TableCell><div className="flex justify-end gap-2">
              {provider.id.startsWith("clp-") && <Button variant="outline" size="sm" disabled={blocked} onClick={() => void download()}>{t(downloading ? "relay.catalog.downloading" : "relay.catalog.update")}</Button>}
              <Button variant="outline" size="sm" disabled={blocked} onClick={event => { returnFocus.current = event.currentTarget; open(provider) }}>{t("relay.extra.manage")}</Button>
            </div></TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {downloadMessage && <p role="status">{t(`relay.catalog.${downloadMessage}`)}</p>}
      </CardContent>
    </Card>
    <Dialog open={draft !== null && !confirmationOpen} onOpenChange={value => { if (!value && !closeBlocked) setDraft(null) }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-4xl" closeLabel={t("relay.close")} showCloseButton={!closeBlocked}
        onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (closeBlocked) event.preventDefault() }}
        onCloseAutoFocus={event => { event.preventDefault(); if (!confirmationOpen) returnFocus.current?.focus() }}>
        <DialogHeader><DialogTitle>{t("relay.extra.manage")} · {draft?.provider}</DialogTitle><DialogDescription>{t("relay.extra.hint")}</DialogDescription></DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          {error && onRefresh && <Button variant="outline" disabled={refreshBlocked || downloading} onClick={onRefresh}>{t("relay.refresh")}</Button>}
          {stale && <Alert><AlertDescription>{t("relay.draftStale")}</AlertDescription></Alert>}
          {stale && selected && <Button variant="outline" disabled={blocked} onClick={() => open(selected)}>{t("relay.reloadDraft")}</Button>}
          {!selected?.available && <Alert><AlertDescription>{t("relay.capabilityUnavailable")}</AlertDescription></Alert>}
          <Table>
            <TableHeader><TableRow><TableHead>{t("relay.extra.modelId")}</TableHead><TableHead>{t("relay.inputFormats")}</TableHead><TableHead>{t("relay.extra.enabledColumn")}</TableHead><TableHead>{t("relay.reasoning")}</TableHead></TableRow></TableHeader>
            <TableBody>{[...new Set([...(selected?.models.map(model => model.id) ?? []), ...(draft?.enabledModels ?? []), ...(draft?.extraModels.map(model => model.id) ?? [])])].map(id => {
              const model = selected?.models.find(value => value.id === id)
              const enabled = draft?.enabledModels.includes(id) ?? false
              const policy = draft?.extraModels.find(value => value.id === id)
              const cline = selected?.id.startsWith("clp-")
              const efforts = cline && catalog && Object.hasOwn(catalog.efforts, id) ? catalog.efforts[id] ?? [] : []
              return <TableRow key={id} data-state={enabled ? "selected" : undefined}>
                <TableCell className="max-w-96 whitespace-normal break-all"><div className="flex flex-col items-start gap-1"><span>{id}</span><Badge variant={enabled ? "default" : "outline"}>{t(enabled ? "relay.extra.enabledState" : "relay.extra.disabledState")}</Badge></div>{!model && <p className="text-muted-foreground">{t("relay.unavailable")}</p>}</TableCell>
                <TableCell><div className="flex flex-wrap gap-1">{model?.inputModalities.length ? model.inputModalities.map(modality => <Badge key={modality} variant="outline">{t(`relay.modalities.${modality}`)}</Badge>) : <Badge variant="outline">{t("relay.capabilityUnknown")}</Badge>}</div></TableCell>
                <TableCell><ToggleGroup type="single" variant="outline" size="sm" value={enabled ? "on" : "off"} disabled={blocked || stale || !selected?.available} aria-label={t("relay.extra.modelToggle", { model: id })} onValueChange={value => { if (value) setEnabled(id, value === "on") }}><ToggleGroupItem value="on" className="min-w-20" disabled={!model}>{enabled && <CheckIcon aria-hidden="true" data-icon="inline-start" />}{t("relay.extra.enabled")}</ToggleGroupItem><ToggleGroupItem value="off" className="min-w-20">{!enabled && <CheckIcon aria-hidden="true" data-icon="inline-start" />}{t("relay.extra.disabled")}</ToggleGroupItem></ToggleGroup></TableCell>
                <TableCell>{cline ? <Select value={policy?.reasoning ?? "passthrough"} disabled={blocked || stale || !selected?.available} onValueChange={value => setReasoning(id, value as RelayExtraModel["reasoning"])}><SelectTrigger aria-label={t("relay.extra.modelReasoning", { model: id })}><SelectValue /></SelectTrigger><SelectContent><SelectGroup><SelectItem value="passthrough">{t("relay.passthrough")}</SelectItem>{[...new Set([...efforts, ...(policy && policy.reasoning !== "passthrough" ? [policy.reasoning] : [])])].map(effort => <SelectItem key={effort} value={effort} disabled={!efforts.includes(effort)}>{effort === "none" ? t("relay.off") : effort}</SelectItem>)}</SelectGroup></SelectContent></Select> : t("relay.passthrough")}</TableCell>
              </TableRow>
            })}</TableBody>
          </Table>
        </div>
        <DialogFooter><Button variant="outline" disabled={closeBlocked} onClick={() => setDraft(null)}>{t("relay.cancel")}</Button><Button disabled={blocked || stale || !selected?.available || !draft || draft.extraModels.length > 64} onClick={() => { if (draft) onSubmit(draft.provider, draft.extraModels, draft.revision, draft.enabledModels) }}>{t("relay.extra.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
