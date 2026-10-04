import { useMemo, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, TruncatedText, type DataTableColumn } from "@/components/metrics/data-table"
import { TrafficContent } from "@/components/traffic/traffic-content"
import { useTranslation } from "@/hooks/use-translation"
import { formatTimestamp } from "@/lib/format"
import { filterLogEntries, serviceLogEntries, type LogEntry, type LogLevelFilter } from "@/lib/service-logs"
import type { ServiceLogsResponse } from "@/lib/types"

export function LogResults({ data, filter, level, stale }: {
  data: ServiceLogsResponse; filter: string; level: LogLevelFilter; stale: boolean
}) {
  const { t } = useTranslation()
  const [frozen, setFrozen] = useState<ServiceLogsResponse | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const viewport = useRef<HTMLElement | null>(null)
  const shown = frozen ?? data
  const entries = useMemo(() => serviceLogEntries(shown), [shown])
  const visible = useMemo(() => filterLogEntries(entries, level, filter), [entries, level, filter])
  const pending = frozen !== null && data !== frozen && JSON.stringify(data.streams) !== JSON.stringify(frozen.streams)
  const labels = { time: t("logs.time"), level: t("logs.level"), module: t("logs.module"), source: t("logs.source"), message: t("logs.message"), details: t("logs.details") }
  const columns: DataTableColumn<LogEntry>[] = [
    { id: "time", header: labels.time, enableSorting: false, cell: ({ row }) => <span className="tabular-nums text-muted-foreground">{row.original.time === null ? t("logs.unknownTime") : formatTimestamp(row.original.time)}</span> },
    { id: "level", header: labels.level, enableSorting: false, cell: ({ row }) => <Badge variant={row.original.level === "error" || row.original.level === "fatal" ? "destructive" : row.original.level === "warn" ? "secondary" : "outline"}>{t(`logs.levels.${row.original.level}`)}</Badge> },
    { id: "module", header: labels.module, enableSorting: false, cell: ({ row }) => <TruncatedText text={row.original.module ?? "—"} className="max-w-48" /> },
    { id: "source", header: labels.source, enableSorting: false, cell: ({ row }) => t(`logs.${row.original.source}`) },
    { id: "message", header: labels.message, enableSorting: false, enableHiding: false, cell: ({ row }) => <TruncatedText text={row.original.message} className="min-w-56 max-w-xl" /> },
    { id: "details", header: labels.details, enableSorting: false, enableHiding: false, cell: ({ row }) => <Button variant="ghost" size="sm" className="-ml-2.5" aria-expanded={expanded === row.original.id} onClick={() => {
      setExpanded(expanded === row.original.id ? null : row.original.id)
      setFrozen(shown)
    }}>{expanded === row.original.id ? t("logs.collapse") : t("logs.details")}</Button> },
  ]
  const count = level !== "all" || filter.trim() ? t("logs.filteredCount", { shown: visible.length, total: entries.length }) : t("logs.count", { count: entries.length })
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <DataTable title={`${t("logs.recent")} · ${count}`} columns={columns} data={visible}
      storageKey="codex-webui:logs-table-v1" columnLabels={labels} getRowId={entry => entry.id}
      pagination={{ mode: "none" }} emptyText={entries.length > 0 ? t("logs.noMatches") : t("logs.empty")}
      onViewportScroll={event => {
        viewport.current = event.currentTarget
        if (event.currentTarget.scrollTop > 16 && frozen === null) setFrozen(data)
      }}
      headerActions={frozen !== null ? <Button variant="outline" size="sm" onClick={() => { setFrozen(null); setExpanded(null); if (viewport.current) viewport.current.scrollTop = 0 }}>{pending ? t("logs.newResults") : t("logs.showLatest")}</Button> : null}
      toolbar={stale || shown.streams.some(stream => stream.missing) ? <div className="flex flex-wrap items-center gap-2">
        {stale ? <Badge variant="outline">{t("refreshStatus.stale")}</Badge> : null}
        {shown.streams.filter(stream => stream.missing).map(stream => <span key={stream.source} className="text-xs text-muted-foreground">{t(`logs.${stream.source}`)} · {t("logs.missing")}</span>)}
      </div> : null}
      renderExpandedRow={entry => expanded === entry.id ? <div className="flex min-w-0 flex-col gap-3">
        {entry.fields !== null && Object.keys(entry.fields).length > 0 ? <TrafficContent title={t("logs.fields")} text={JSON.stringify(entry.fields)} json /> : null}
        <TrafficContent title={t("logs.raw")} text={entry.raw} />
      </div> : null}
    />
  </div>
}
