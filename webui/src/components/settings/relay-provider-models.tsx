import { useCallback, useEffect, useRef, useState } from "react"
import { formatTimestamp } from "@/lib/format"
import { updateRelayCatalog } from "@/lib/api"
import type { RelayManagementSnapshot } from "@/lib/types"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog"
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function RelayProviderModels({ snapshot, blocked: parentBlocked, refreshBlocked = parentBlocked, error, onRefresh }: {
  snapshot: RelayManagementSnapshot
  blocked: boolean
  refreshBlocked?: boolean
  error?: string | null
  onRefresh?: () => void
}) {
  const { t } = useTranslation()
  const [providerId, setProviderId] = useState<string | null>(null)
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
  const selected = snapshot.providers.find(provider => provider.id === providerId)
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
            <TableCell>{t("relay.extra.modelCount", { count: provider.models.length })}</TableCell>
            <TableCell><div className="flex justify-end gap-2">
              {provider.id.startsWith("clp-") && <Button variant="outline" size="sm" disabled={blocked} onClick={() => void download()}>{t(downloading ? "relay.catalog.downloading" : "relay.catalog.update")}</Button>}
              <Button variant="outline" size="sm" disabled={blocked} onClick={event => { returnFocus.current = event.currentTarget; setProviderId(provider.id) }}>{t("relay.extra.manage")}</Button>
            </div></TableCell>
          </TableRow>)}</TableBody>
        </Table>
        {downloadMessage && <p role="status">{t(`relay.catalog.${downloadMessage}`)}</p>}
      </CardContent>
    </Card>
    <Dialog open={providerId !== null} onOpenChange={value => { if (!value && !closeBlocked) setProviderId(null) }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-5xl" closeLabel={t("relay.close")} showCloseButton={!closeBlocked}
        onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => { if (closeBlocked) event.preventDefault() }}
        onCloseAutoFocus={event => { event.preventDefault(); returnFocus.current?.focus() }}>
        <DialogHeader><DialogTitle>{t("relay.extra.manage")} · {providerId}</DialogTitle><DialogDescription>{t("relay.extra.hint")}</DialogDescription></DialogHeader>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
          {error && onRefresh && <Button variant="outline" disabled={refreshBlocked || downloading} onClick={onRefresh}>{t("relay.refresh")}</Button>}
          {!selected?.available && <Alert><AlertDescription>{t("relay.capabilityUnavailable")}</AlertDescription></Alert>}
          <Table>
            <TableHeader><TableRow><TableHead>{t("relay.extra.modelId")}</TableHead><TableHead>{t("relay.inputFormats")}</TableHead><TableHead>{t("relay.protocol")}</TableHead></TableRow></TableHeader>
            <TableBody>{selected?.models.map(model => <TableRow key={model.relayId}>
              <TableCell>{model.relayId}</TableCell>
              <TableCell><div className="flex flex-nowrap gap-1">{model.inputModalities.length ? model.inputModalities.map(modality => <Badge key={modality} variant="outline">{t(`relay.modalities.${modality}`)}</Badge>) : <Badge variant="outline">{t("relay.capabilityUnknown")}</Badge>}</div></TableCell>
              <TableCell><div className="flex gap-1">{selected.protocols?.map(protocol => <Badge key={protocol} variant="outline">{protocol === "chat" ? "Chat" : "Responses"}</Badge>)}</div></TableCell>
            </TableRow>)}</TableBody>
          </Table>
        </div>
        <DialogFooter><Button variant="outline" disabled={closeBlocked} onClick={() => setProviderId(null)}>{t("relay.close")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}
