import { Link } from "react-router"
import { DataTable, TableHint, TruncatedText, type DataTableColumn, type DataTableProps } from "@/components/metrics/data-table"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { FastBadge } from "@/components/metrics/service-tier"
import { StatusBadge } from "@/components/metrics/status-badge"
import { Badge } from "@/components/ui/badge"
import { TrafficModel } from "@/components/traffic/traffic-model"
import { useTranslation } from "@/hooks/use-translation"
import { formatErrorMessage, formatErrorType, formatTime, isClientInterruption } from "@/lib/format"
import { metricsLink } from "@/lib/metrics-query"
import type { MetricsQuery, RequestRecord } from "@/lib/types"

export function ErrorsTable({ records, query, loading, pagination }: {
  records: RequestRecord[]; query: MetricsQuery; loading: boolean; pagination: DataTableProps<RequestRecord>["pagination"]
}) {
  const { t, language } = useTranslation()
  const columns: DataTableColumn<RequestRecord>[] = [
    { id: "time", enableSorting: false, header: t("metrics.time"), cell: ({ row: { original: record } }) => {
      return <><span className="tabular-nums text-muted-foreground">{formatTime(record.recordedAtMs)}</span></>
    } },
    { id: "provider", enableSorting: false, header: t("metrics.provider"), cell: ({ row: { original: record } }) => {
      return <><ProviderBadge provider={record.provider} /></>
    } },
    { id: "model", enableSorting: false, header: t("metrics.model"), cell: ({ row: { original: record } }) => {
      return <><span className="flex items-center gap-2 whitespace-nowrap"><TrafficModel provider={record.provider} request={record.model} responses={[]} /><FastBadge tier={record.requestServiceTier} source="request" responseTier={record.serviceTier} /></span></>
    } },
    { id: "reasoningEffort", enableSorting: false, header: t("metrics.reasoningEffort"), cell: ({ row }) => row.original.reasoningEffort ?? "—" },
    { id: "status", enableSorting: false, header: t("filters.status"), cell: ({ row: { original: record } }) => {
      return isClientInterruption(record) ? <Badge variant="secondary">{t("metrics.interrupted")}</Badge> : <StatusBadge status={record.status} />
    } },
    { id: "http", enableSorting: false, header: "HTTP", cell: ({ row: { original: record } }) => {
      return <>{record.httpStatus ?? "—"}</>
    } },
    { id: "detail", enableSorting: false, header: t("errorList.detailColumn"), cell: ({ row: { original: record } }) => {
      const message = isClientInterruption(record) ? t("metrics.clientInterruption") : record.errorMessage === null ? formatErrorType(record.errorType ?? record.errorCode, language) : formatErrorMessage(record.errorMessage, language)
      return <>{record.errorCode ? <TableHint hint={`${message} · ${t("common.errorCode", { code: record.errorCode })}`}>
                              <span className="block max-w-md truncate text-xs text-muted-foreground">{message}</span>
                            </TableHint> : <TruncatedText text={message} className="max-w-md text-xs text-muted-foreground" />}</>
    } },
    { id: "thread", enableSorting: false, header: t("errorList.threadColumn"), cell: ({ row: { original: record } }) => {
      return <>{record.threadId === null ? "—" : <TruncatedText render={<Link className="underline-offset-4 hover:underline" to={metricsLink("/requests", query, { threadId: record.threadId, turnId: record.turnId ?? undefined, status: undefined })} />} text={record.turnId ?? record.threadId} className="max-w-40">{record.turnId ?? record.threadId}</TruncatedText>}</>
    } },
  ]
  return <DataTable title={t("errorList.tableTitle")} description={() => t("errorList.tableDescription")}
    columns={columns} data={records} getRowId={row => String(row.id)} loading={loading}
    storageKey="codex-webui:errors-table-v1" numericColumnIds={["http"]}
    columnLabels={{time: t("metrics.time"), provider: t("metrics.provider"), model: t("metrics.model"), reasoningEffort: t("metrics.reasoningEffort"), status: t("filters.status"), http: "HTTP", detail: t("errorList.detailColumn"), thread: t("errorList.threadColumn")}}
    emptyText={t("common.noFailedRequests")} pagination={pagination} />
}
