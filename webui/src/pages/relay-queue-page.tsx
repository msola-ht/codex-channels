import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DataTable, SortableHeader, TruncatedText, type DataTableColumn } from "@/components/metrics/data-table"
import type { RelayQueueSnapshot } from "@/lib/types"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { useTranslation } from "@/hooks/use-translation"
import { useRelayQueue } from "@/hooks/use-relay-queue"
import { translateApiError } from "@/lib/i18n/translate"
import { formatElapsedDuration } from "@/lib/format"

export function RelayQueuePage() {
  const { t } = useTranslation()
  const { data, loading, error, errorCode, refetch, notificationStatus } = useRelayQueue()
  type Row = Extract<RelayQueueSnapshot, { state: "running" }>["requests"][number]
  const columns: DataTableColumn<Row>[] = [
    { id: "caller", accessorFn: row => row.displayName ?? row.callerId, header: ({ column }) => <SortableHeader column={column}>{t("relay.callerId")}</SortableHeader>, cell: ({ row: { original: row } }) => <TruncatedText text={row.displayName ?? row.callerId} /> },
    { accessorKey: "model", header: ({ column }) => <SortableHeader column={column}>{t("relay.queueModel")}</SortableHeader>, cell: ({ row: { original: row } }) => <div className="flex max-w-56 flex-col gap-1"><TruncatedText text={row.model ?? t("relay.queueModelPending")} /><TruncatedText text={`${row.provider} · ${row.protocol === "chat" ? "Chat" : "Responses"}`} className="text-xs text-muted-foreground" /></div> },
    { accessorKey: "phase", header: ({ column }) => <SortableHeader column={column}>{t("relay.queuePhase")}</SortableHeader>, cell: ({ row: { original: row } }) => <Badge variant={row.phase === "queue" ? "outline" : "secondary"}>{t(`relay.queuePhases.${row.phase}`)}</Badge> },
    { accessorKey: "elapsedMs", header: ({ column }) => <SortableHeader column={column}>{t("relay.queueElapsed")}</SortableHeader>, cell: ({ row: { original: row } }) => formatElapsedDuration(row.elapsedMs) },
  ]
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
    <div><h1 tabIndex={-1} className="text-xl font-semibold">{t("relay.queueDetails")}</h1><p className="text-sm text-muted-foreground">{t("relay.queueLiveHint")}</p></div>
    <div className="flex shrink-0 items-center justify-between gap-2">
      <span className="w-40 text-xs text-muted-foreground" role="status">{t(`delivery.notifications.${notificationStatus ?? "connecting"}`)}</span>
      <Button size="sm" variant="outline" className="w-24 shrink-0" disabled={loading} onClick={refetch}>
        {loading && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("relay.refresh")}
      </Button>
    </div>
    <ErrorBanner error={error ? translateApiError(t, error, errorCode) : null} />
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto" aria-busy={loading}>
      {loading && !data && !error && <DataTable title={t("relay.queueDetails")} description={() => t("relay.queueSnapshotHint")} data={[]} columns={columns} loading storageKey="codex-webui:relay-queue-table-v1" pagination={{ mode: "client", defaultSorting: [], defaultPageSize: 10 }} />}
      {!error && data && (data.state !== "running"
        ? <Alert><AlertDescription>{t(data.state === "stopped" ? "relay.stopped" : "relay.runtimeUnknown")}</AlertDescription></Alert>
        : <div className="flex min-h-0 flex-1 flex-col gap-3">
          {(!data.configurationValid || !data.enabled || !data.listening) && <Alert><AlertDescription>{t(!data.configurationValid
            ? "relay.queueInvalid" : !data.enabled ? "relay.queueDisabled" : "relay.queueNotListening")}</AlertDescription></Alert>}
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">{t("relay.activeCount", { count: data.requests.filter(row => !["input", "queue"].includes(row.phase)).length })}</Badge>
            <Badge variant="outline">{t("relay.waitingCount", { count: data.requests.filter(row => row.phase === "queue").length })}</Badge>
            <Badge variant="outline">{t("relay.uploadingCount", { count: data.requests.filter(row => row.phase === "input").length })}</Badge>
          </div>
          <DataTable title={t("relay.queueDetails")} description={() => t("relay.queueSnapshotHint")}
            data={data.requests} columns={columns} getRowId={row => row.requestId} storageKey="codex-webui:relay-queue-table-v1"
            columnLabels={{ caller: t("relay.callerId"), model: t("relay.queueModel"), phase: t("relay.queuePhase"), elapsedMs: t("relay.queueElapsed") }}
            numericColumnIds={["elapsedMs"]} emptyText={t("relay.queueEmpty")}
            pagination={{ mode: "client", defaultSorting: [], defaultPageSize: 10, pageSizeOptions: [10, 25, 50] }} />
        </div>)}
    </div>
  </div>
}
