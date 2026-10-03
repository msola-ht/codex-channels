import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Spinner } from "@/components/ui/spinner"
import { DataTable, TruncatedText, type DataTableColumn } from "@/components/metrics/data-table"
import { useTranslation } from "@/hooks/use-translation"
import { useDeliveryContents, useDeliveryQueue } from "@/hooks/use-delivery-queue"
import { translateApiError } from "@/lib/i18n/translate"
import { formatTime, formatTimestamp } from "@/lib/format"
import type { DeliveryQueueEntry } from "@/lib/types"

const filters = ["all", "pending", "sending", "uncertain", "blocked"] as const
type Filter = typeof filters[number]
const eventLabels = {
  "text.completed": "text", "turn.started": "turnStarted", "turn.completed": "turnCompleted",
  "operation.updated": "operation", "subagent.spawned": "agentStarted", "subagent.contacted": "agentContacted", "subagent.completed": "agentCompleted",
  "connection.lost": "disconnected", "connection.restored": "reconnected", "thread.availability": "availability", "thread.name": "name",
  "mcp.oauth.completed": "authorization", "warning": "warning", "conversation.idle.released": "released",
} as const
const statusLabels = { running: "running", inProgress: "running", completed: "completed", failed: "failed", declined: "declined", interrupted: "interrupted", shutdown: "shutdown", errored: "failed", notFound: "notFound" } as const

export function DeliveryQueue() {
  const [filter, setFilter] = useState<Filter>("all")
  const [cursors, setCursors] = useState([0])
  const before = cursors.at(-1) ?? 0
  return <DeliveryQueueList key={`${filter}:${before}`} filter={filter} before={before} pageNumber={cursors.length}
    onFilter={value => { setFilter(value); setCursors([0]) }}
    onNext={value => setCursors([...cursors, value])}
    onPrevious={() => setCursors(cursors.slice(0, -1))} />
}

function DeliveryQueueList({ filter, before, pageNumber, onFilter, onNext, onPrevious }: {
  filter: Filter; before: number; pageNumber: number; onFilter(value: Filter): void; onNext(value: number): void; onPrevious(): void
}) {
  const { t } = useTranslation()
  const queue = useDeliveryQueue(before, filter)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { data, loading, error, errorCode, refetch, busy, pendingPreview } = queue
  const locked = busy || pendingPreview !== null
  const summaries = useDeliveryContents(error ? [] : data?.records ?? [])
  const [selected, setSelected] = useState<Record<string, string>>({})
  const eligible = !error ? data?.records.filter(row => row.state === "uncertain" || row.state === "blocked") ?? [] : []
  const chosen = eligible.filter(row => selected[row.id] === row.revision)
  const process = (action: "retry" | "ignore") => queue.mutate({ action, entries: chosen.map(({ id, revision }) => ({ id, revision })) })
  const columns: DataTableColumn<DeliveryQueueEntry>[] = [
    { id: "select", enableHiding: false, enableSorting: false,
      header: () => <Checkbox aria-label={t("delivery.selectPage")} disabled={!eligible.length || locked || loading}
        checked={chosen.length > 0 && chosen.length === eligible.length}
        indeterminate={chosen.length > 0 && chosen.length < eligible.length}
        onCheckedChange={value => setSelected(value === true ? Object.fromEntries(eligible.map(row => [row.id, row.revision])) : {})} />,
      cell: ({ row: { original: row } }) => <Checkbox aria-label={t("delivery.selectRecord", { id: row.id })} checked={selected[row.id] === row.revision}
        disabled={loading || locked || !["uncertain", "blocked"].includes(row.state)} onCheckedChange={value => setSelected({ ...selected, [row.id]: value === true ? row.revision : "" })} /> },
    { id: "conversation", enableSorting: false, header: t("delivery.conversation"), cell: ({ row: { original: row } }) => <div className="flex max-w-80 flex-col gap-1">
      <TruncatedText text={conversationLabel(row.conversation, row.account)} /><TruncatedText text={displayIdentity(row.account)} className="text-xs text-muted-foreground" /></div> },
    { id: "content", enableSorting: false, header: t("delivery.contentSummary"), cell: ({ row: { original: row } }) => {
      const result = summaries.data?.get(JSON.stringify([row.id, row.revision]))
      const content = result?.content
      if (!content) return <span className="text-xs text-muted-foreground">{t(result?.error || summaries.error ? "delivery.summaryUnavailable" : "common.loading")}</span>
      const eventLabel = eventLabels[content.type as keyof typeof eventLabels] ?? "unknown"
      const statusLabel = content.status ? statusLabels[content.status as keyof typeof statusLabels] ?? "unknown" : null
      return <div className="flex min-w-48 max-w-80 flex-col gap-1">
        <span className="text-xs text-muted-foreground">{t(`delivery.events.${eventLabel}`)}{statusLabel ? ` · ${t(`delivery.contentStates.${statusLabel}`)}` : ""}</span>
        {content.text ? <p className="line-clamp-2 whitespace-normal break-words">{content.text}</p> : content.imageFormat ? <span>{t("delivery.image", { format: content.imageFormat.toUpperCase() })}</span> : null}
      </div>
    } },
    { id: "state", enableSorting: false, header: t("delivery.status"), cell: ({ row: { original: row } }) => <Badge variant={row.state === "uncertain" || row.state === "blocked" ? "destructive" : "secondary"}>{t(`delivery.states.${row.state}`)}</Badge> },
    { id: "time", enableSorting: false, header: t("delivery.createdAt"), cell: ({ row: { original: row } }) => <span className="tabular-nums text-muted-foreground" title={formatTimestamp(row.createdAt)}>{formatTime(row.createdAt)}</span> },
    { id: "actions", enableSorting: false, enableHiding: false, header: t("delivery.actions"), cell: ({ row: { original: row } }) => <div className="flex gap-2">
      {["uncertain", "blocked"].includes(row.state) && <Button size="sm" variant="outline" disabled={loading || locked} onClick={() => void queue.mutate({ action: "retry", entries: [{ id: row.id, revision: row.revision }] })}>{t("delivery.retry")}</Button>}
    </div> },
  ]
  return <div className="flex min-h-min min-w-0 flex-1 flex-col gap-4">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
      <ToggleGroup variant="outline" size="sm" value={[filter]} disabled={locked} aria-label={t("delivery.filter")}
        onValueChange={([value]) => { if (filters.includes(value as Filter)) onFilter(value as Filter) }} className="flex-wrap">
        {filters.map(value => <ToggleGroupItem key={value} value={value}>{t(`delivery.states.${value}`)}{!error && data?.summary && <span className="tabular-nums">{value === "all" ? data.summary.records : data.summary[value]}</span>}</ToggleGroupItem>)}
      </ToggleGroup>
      <div className="flex items-center gap-2">
      <span className="w-40 text-right text-xs text-muted-foreground" role="status">{t(`delivery.notifications.${queue.notificationStatus ?? "connecting"}`)}</span>
      <Button size="sm" variant="outline" className="w-36 shrink-0" disabled={loading || locked} onClick={() => { refetch(); summaries.refetch() }} aria-busy={loading || busy}>
        <span className="flex size-4 items-center justify-center">{(loading || busy) && <Spinner aria-hidden="true" />}</span>
        {t(busy && !pendingPreview ? "delivery.processing" : loading ? "delivery.refreshing" : "relay.refresh")}
      </Button>
      </div>
    </div>
    {busy && !pendingPreview && <span role="status" className="sr-only">{t("delivery.preparing")}</span>}
    {error && <Alert variant="destructive"><AlertDescription>{translateApiError(t, error, errorCode)}</AlertDescription></Alert>}
    {queue.actionError && <Alert variant="destructive"><AlertDescription>{translateApiError(t, queue.actionError, queue.actionErrorCode)}</AlertDescription></Alert>}
    {queue.result && <Alert variant={queue.result.cleanupStatus === "unconfirmed" ? "destructive" : "default"}><AlertDescription>{t(queue.result.cleanupStatus === "unconfirmed" ? "delivery.cleanupUnconfirmed" : queue.result.auditStatus === "failed" ? "delivery.batchAuditFailed" : queue.result.result === "ignored" ? "delivery.ignored" : "delivery.saved")}</AlertDescription></Alert>}
    {queue.result?.cleanupStatus === "unconfirmed" && queue.result.auditStatus === "failed" && <Alert variant="destructive"><AlertDescription>{t("delivery.auditFailed")}</AlertDescription></Alert>}
    {error ? null : data?.state === "missing" ? <Alert><AlertDescription>{t("delivery.missing")}</AlertDescription></Alert> : <DataTable
      title={t("delivery.listTitle")} description={() => t("delivery.listSummary", { count: data?.summary ? filter === "all" ? data.summary.records : data.summary[filter] : 0 })}
      data={data?.records ?? []} columns={columns} getRowId={row => row.id} loading={loading && !data}
      storageKey="codex-webui:delivery-table-v1" columnLabels={{ content: t("delivery.contentSummary"), conversation: t("delivery.conversation"), state: t("delivery.status"), time: t("delivery.createdAt") }}
      emptyText={t(before === 0 ? "delivery.empty" : "delivery.pageEmpty")}
      toolbar={<div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">{t("delivery.selected", { count: chosen.length })}</span>
      <Button size="sm" variant="outline" disabled={!chosen.length || loading || locked} onClick={() => void process("retry")}>{t("delivery.batchRetry")}</Button>
      <Button size="sm" variant="destructive" disabled={!chosen.length || loading || locked} onClick={() => void process("ignore")}>{t("delivery.batchIgnore")}</Button>
    </div>}
      pagination={{ mode: "server", pageNumber, pageSize: 50, pageSizeOptions: [50], onPageSizeChange: () => {}, sorting: [], onSortingChange: () => {},
        serverTotal: data?.summary ? filter === "all" ? data.summary.records : data.summary[filter] : 0,
        hasPrevious: before !== 0 && !locked, hasNext: !loading && !locked && data?.nextCursor != null, onPrevious,
        onNext: () => { if (data?.nextCursor != null) onNext(data.nextCursor) } }} />}
    <AlertDialog open={pendingPreview !== null} onOpenChange={(value, details) => { if (busy) { details.cancel(); return }; if (!value) queue.cancel() }}>
      <AlertDialogContent initialFocus={cancelRef} className="max-h-[90dvh] overflow-y-auto">
        <AlertDialogHeader><AlertDialogTitle>{t(pendingPreview?.input.action === "ignore" ? "delivery.ignoreTitle" : "delivery.confirmTitle")}</AlertDialogTitle><AlertDialogDescription>{t(pendingPreview?.input.action === "ignore" ? "delivery.ignoreHint" : "delivery.confirmHint")}</AlertDialogDescription></AlertDialogHeader>
        <p className="text-sm">{t("delivery.selected", { count: pendingPreview?.preview.count ?? 0 })}</p>
        <div className="max-h-48 overflow-y-auto" role="region" aria-label={t("delivery.reviewSelection")} tabIndex={0}>
          <ul className="flex flex-col gap-3">
            {pendingPreview?.input.entries.map(entry => {
              const row = data?.records.find(row => row.id === entry.id && row.revision === entry.revision)
              return <li key={entry.id} className="flex min-w-0 flex-col gap-1">
                {row && <><p className="break-all">{conversationLabel(row.conversation, row.account)}</p><p className="break-all text-xs text-muted-foreground">{displayIdentity(row.account)}</p></>}
                <p className="break-all text-xs text-muted-foreground">{t("delivery.id")}: {entry.id}</p>
              </li>
            })}
          </ul>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} disabled={busy}>{t("delivery.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant={pendingPreview?.input.action === "ignore" ? "destructive" : "default"} aria-busy={busy} disabled={busy || loading} onClick={event => { event.preventDefault(); void queue.confirm() }}>{busy && <Spinner data-icon="inline-start" aria-hidden="true" />}{t(busy ? "delivery.processing" : pendingPreview?.input.action === "ignore" ? "delivery.ignoreConfirm" : "delivery.confirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

/** Format the stored identity for display only; never use it for routing. */
function displayIdentity(value: string): string {
  try {
    const parts: unknown = JSON.parse(value)
    if (Array.isArray(parts) && parts.every(part => typeof part === "string")) return parts.join(" · ")
  } catch { /* Keep an opaque stored identifier visible for diagnosis. */ }
  return value
}

function conversationLabel(conversation: string, account: string): string {
  try {
    const target: unknown = JSON.parse(conversation)
    const owner: unknown = JSON.parse(account)
    if (Array.isArray(target) && target.length === 3 && target.every(value => typeof value === "string") &&
      Array.isArray(owner) && owner.length === 2 && target[0] === owner[0] && target[1] === owner[1]) return target[2]
  } catch { /* Preserve identifiers whose structure is not recognized. */ }
  return displayIdentity(conversation)
}
