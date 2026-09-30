import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { useTranslation } from "@/hooks/use-translation"
import { useRelayQueue } from "@/hooks/use-relay-queue"
import { translateApiError } from "@/lib/i18n/translate"
import { formatElapsedDuration } from "@/lib/format"

export function RelayQueueSheet() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return <Sheet open={open} onOpenChange={setOpen}>
    <SheetTrigger asChild><Button variant="outline">{t("relay.queueDetails")}</Button></SheetTrigger>
    <SheetContent side="right" closeLabel={t("relay.close")} className="data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
      <SheetHeader className="max-h-[35dvh] shrink-0 overflow-y-auto pr-12"><SheetTitle>{t("relay.queueDetails")}</SheetTitle><SheetDescription>{t("relay.queueLiveHint")}</SheetDescription></SheetHeader>
      {open && <RelayQueueList />}
    </SheetContent>
  </Sheet>
}

function RelayQueueList() {
  const { t } = useTranslation()
  const { data, loading, error, errorCode, refetch } = useRelayQueue()
  return <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
    <div className="flex shrink-0 items-center justify-between gap-2">
      <p className="text-sm text-muted-foreground">{t("relay.queueSnapshotHint")}</p>
      <Button size="sm" variant="outline" className="shrink-0" disabled={loading} onClick={refetch}>
        {loading && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.refresh")}
      </Button>
    </div>
    <ErrorBanner error={error ? translateApiError(t, error, errorCode) : null} />
    <div className="min-h-0 overflow-y-auto" aria-busy={loading}>
      {loading && !data && <div role="status" aria-label={t("common.loading")} className="flex flex-col gap-3">
        {[0, 1, 2].map(index => <Skeleton key={index} className="h-36 w-full shrink-0" />)}
      </div>}
      {!error && data && (data.state !== "running"
        ? <Alert><AlertDescription>{t(data.state === "stopped" ? "relay.stopped" : "relay.runtimeUnknown")}</AlertDescription></Alert>
        : <div className="flex flex-col gap-3">
          {(!data.configurationValid || !data.enabled || !data.listening) && <Alert><AlertDescription>{t(!data.configurationValid
            ? "relay.queueInvalid" : !data.enabled ? "relay.queueDisabled" : "relay.queueNotListening")}</AlertDescription></Alert>}
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{t("relay.activeCount", { count: data.requests.filter(row => !["input", "queue"].includes(row.phase)).length })}</Badge>
            <Badge variant="outline">{t("relay.waitingCount", { count: data.requests.filter(row => row.phase === "queue").length })}</Badge>
            <Badge variant="outline">{t("relay.uploadingCount", { count: data.requests.filter(row => row.phase === "input").length })}</Badge>
          </div>
          {!data.requests.length ? <Empty><EmptyHeader><EmptyDescription>{t("relay.queueEmpty")}</EmptyDescription></EmptyHeader></Empty>
            : <ul className="flex flex-col gap-3" aria-label={t("relay.queueDetails")}>{data.requests.map(row => <li key={row.requestId}>
              <Card size="sm">
                <CardHeader>
                  <CardTitle className="min-w-0 break-all">{row.displayName ?? row.callerId}</CardTitle>
                  <CardDescription><Badge variant={row.phase === "queue" ? "outline" : "secondary"}>{t(`relay.queuePhases.${row.phase}`)}</Badge></CardDescription>
                </CardHeader>
                <CardContent><dl className="grid min-w-0 grid-cols-2 gap-3">
                  <div className="min-w-0"><dt className="text-muted-foreground">{t("relay.provider")}</dt><dd className="break-all">{row.provider}</dd></div>
                  <div><dt className="text-muted-foreground">{t("relay.protocol")}</dt><dd>{row.protocol === "chat" ? "Chat" : "Responses"}</dd></div>
                  <div className="col-span-2 min-w-0"><dt className="text-muted-foreground">{t("relay.queueModel")}</dt><dd className="break-all">{row.model ?? t("relay.queueModelPending")}</dd></div>
                  <div className="col-span-2"><dt className="text-muted-foreground">{t("relay.queueElapsed")}</dt><dd className="tabular-nums">{formatElapsedDuration(row.elapsedMs)}</dd></div>
                </dl></CardContent>
              </Card>
            </li>)}</ul>}
        </div>)}
    </div>
  </div>
}
