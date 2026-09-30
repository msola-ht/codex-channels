import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { useTranslation } from "@/hooks/use-translation"
import { useRelayQueue } from "@/hooks/use-relay-queue"
import { translateApiError } from "@/lib/i18n/translate"
import { formatElapsedDuration } from "@/lib/format"
import type { RelayManagedCaller } from "@/lib/types"

export function RelayQueueSheet({ callers }: { callers: RelayManagedCaller[] }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild><Button variant="outline">{t("relay.queueDetails")}</Button></SheetTrigger>
    <SheetContent side="right" closeLabel={t("relay.close")} className="data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
      <SheetHeader className="pr-12"><SheetTitle>{t("relay.queueDetails")}</SheetTitle><SheetDescription>{t("relay.queueLiveHint")}</SheetDescription></SheetHeader>
      {open && <RelayQueueList callers={callers} />}
    </SheetContent>
  </Sheet>
}

function RelayQueueList({ callers }: { callers: RelayManagedCaller[] }) {
  const { t } = useTranslation()
  const { data, loading, error, errorCode, refetch } = useRelayQueue()
  return <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
    <div className="flex items-center justify-between gap-2">
      <p role="status" className="text-sm text-muted-foreground">{t(loading ? "common.loading" : "relay.queueSnapshotHint")}</p>
      <Button size="sm" variant="outline" disabled={loading} onClick={refetch}>{t("relay.refresh")}</Button>
    </div>
    <ErrorBanner error={error ? translateApiError(t, error, errorCode) : null} />
    {!error && data && (data.state !== "running"
      ? <p>{t(data.state === "stopped" ? "relay.stopped" : "relay.runtimeUnknown")}</p>
      : <>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{t("relay.activeCount", { count: data.requests.filter(row => !["input", "queue"].includes(row.phase)).length })}</Badge>
          <Badge variant="outline">{t("relay.waitingCount", { count: data.requests.filter(row => row.phase === "queue").length })}</Badge>
          <Badge variant="outline">{t("relay.uploadingCount", { count: data.requests.filter(row => row.phase === "input").length })}</Badge>
        </div>
        <Table><TableHeader><TableRow>
          {(["purpose", "provider", "models", "protocol", "queuePhase", "queueElapsed"] as const).map(column => <TableHead key={column}>{t(`relay.${column}`)}</TableHead>)}
        </TableRow></TableHeader><TableBody>
          {data.requests.map(row => <TableRow key={row.requestId}>
            <TableCell className="max-w-40 whitespace-normal break-words">{callers.find(caller => caller.caller_id === row.callerId)?.display_name ?? row.callerId}</TableCell>
            <TableCell className="max-w-32 whitespace-normal break-all">{row.provider}</TableCell>
            <TableCell className="max-w-48 whitespace-normal break-all">{row.model ?? t("relay.queueModelPending")}</TableCell>
            <TableCell>{row.protocol === "chat" ? "Chat" : "Responses"}</TableCell>
            <TableCell><Badge variant="outline">{t(`relay.queuePhases.${row.phase}`)}</Badge></TableCell>
            <TableCell>{formatElapsedDuration(row.elapsedMs)}</TableCell>
          </TableRow>)}
          {!data.requests.length && <TableRow><TableCell colSpan={6}>{t("relay.queueEmpty")}</TableCell></TableRow>}
        </TableBody></Table>
      </>)}
  </div>
}
