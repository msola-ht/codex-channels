import { Link } from "react-router"
import { ArrowDownIcon, ArrowUpIcon, ArrowUpDownIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react"

import { TableHint, TruncatedText } from "@/components/metrics/data-table"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useThreadSubagents } from "@/hooks/use-thread-subagents"
import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatModelName, formatTime, formatTokens, shortThreadId } from "@/lib/format"
import { translateApiError } from "@/lib/i18n/translate"
import { metricsLink } from "@/lib/metrics-query"

export function ThreadSubagents({ threadId, revision }: { threadId: string; revision?: unknown }) {
  const { t } = useTranslation()
  const { data, loading, refreshing, error, errorCode, refetch, pagination, sorting } = useThreadSubagents(threadId, revision)
  const timeHeader = (key: "time" | "last", label: string) => {
    const active = sorting.sortKey === key
    const Icon = active ? sorting.sortDirection === "asc" ? ArrowUpIcon : ArrowDownIcon : ArrowUpDownIcon
    return <TableHead scope="col" aria-sort={active ? sorting.sortDirection === "asc" ? "ascending" : "descending" : "none"}>
      <Button variant="ghost" size="sm" onClick={() => sorting.onSort(key)}>{label}<Icon data-icon="inline-end" /></Button>
    </TableHead>
  }
  return <section aria-label={t("threads.relatedSubagents")} aria-busy={refreshing} className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium"><TableHint hint={t("threads.subagentMetricsHint")}>{t("threads.relatedSubagents")}</TableHint></h2>
      <Button variant="ghost" size="sm" disabled={refreshing} onClick={refetch}>{refreshing ? t("common.refreshing") : t("common.refresh")}</Button>
    </div>
    <ErrorBanner error={translateApiError(t, error, errorCode)} pending={refreshing} onRetry={refetch} />
    {loading ? <div className="flex flex-col gap-2" aria-label={t("common.loading")}>
      {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-6 w-full" />)}
    </div> : error !== null ? null : data?.subagents.length === 0 ? <Empty className="py-3">
      <EmptyHeader><EmptyTitle>{t("threads.subagentsEmpty")}</EmptyTitle></EmptyHeader>
    </Empty> : <Table aria-label={t("threads.relatedSubagents")}>
      <TableHeader><TableRow>
        {timeHeader("time", t("threads.firstRequest"))}
        <TableHead scope="col">{t("threads.subagent")}</TableHead>
        <TableHead scope="col">{t("metrics.thread")}</TableHead>
        <TableHead scope="col">{t("metrics.provider")}</TableHead>
        <TableHead scope="col">{t("metrics.model")}</TableHead>
        <TableHead scope="col" className="text-right">{t("metrics.turn")}</TableHead>
        <TableHead scope="col" className="text-right">{t("metrics.requests")}</TableHead>
        <TableHead scope="col" className="text-right">{t("metrics.input")}</TableHead>
        <TableHead scope="col" className="text-right">{t("metrics.cacheHitRate")}</TableHead>
        <TableHead scope="col" className="text-right">{t("metrics.output")}</TableHead>
        {timeHeader("last", t("metrics.last"))}
        <TableHead scope="col" className="text-right">{t("threads.directSubagents")}</TableHead>
      </TableRow></TableHeader>
      <TableBody>
      {data?.subagents.map(agent => {
        const name = agent.agentPath.split("/").filter(Boolean).at(-1) ?? agent.agentPath
        const detailLink = metricsLink(`/threads/${encodeURIComponent(agent.threadId)}`, { range: "all" })
        return <TableRow key={agent.threadId}>
            <TableCell className="tabular-nums">{agent.firstRequestStartedAtMs == null ? "—" : formatTime(agent.firstRequestStartedAtMs)}</TableCell>
            <TableCell>
              <Link to={detailLink} title={agent.agentPath} className="block max-w-64 truncate hover:underline">{name}</Link>
            </TableCell>
            <TableCell>
              <Link to={detailLink} title={agent.threadId} className="hover:underline">{shortThreadId(agent.threadId)}</Link>
            </TableCell>
            <TableCell><ProviderBadge provider={agent.provider} /></TableCell>
            <TableCell><TruncatedText text={formatModelName(agent.model, agent.provider)} className="max-w-40" /></TableCell>
            <TableCell className="text-right tabular-nums">{agent.turnCount}</TableCell>
            <TableCell className="text-right tabular-nums">{agent.requestCount}</TableCell>
            <TableCell className="text-right tabular-nums">{formatTokens(agent.inputTokens)}</TableCell>
            <TableCell className="text-right tabular-nums">{formatCacheUsage(agent.cacheUsage).rate}</TableCell>
            <TableCell className="text-right tabular-nums">{formatTokens(agent.outputTokens)}</TableCell>
            <TableCell className="tabular-nums">{agent.lastRecordedAtMs == null ? "—" : formatTime(agent.lastRecordedAtMs)}</TableCell>
            <TableCell className="text-right">
              {agent.directSubagentCount > 0 ? <Badge variant="secondary" size="sm">
                {t("threads.subagentsCount", { count: agent.directSubagentCount })}
              </Badge> : "—"}
            </TableCell>
        </TableRow>
      })}
      </TableBody>
    </Table>}
    {data === null ? null : <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-muted-foreground">{t("threads.subagentsTotal", { total: data.total })}</p>
      {data.total > 20 || pagination.pageNumber > 1 ? <nav aria-label={t("threads.subagentsPagination")} className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" disabled={!pagination.hasPrevious} onClick={pagination.onPrevious} aria-label={t("common.previous")}><ChevronLeftIcon /></Button>
        <span className="text-xs tabular-nums">{t("common.page", { page: pagination.pageNumber })}</span>
        <Button variant="ghost" size="icon-sm" disabled={!pagination.hasNext} onClick={pagination.onNext} aria-label={t("common.next")}><ChevronRightIcon /></Button>
      </nav> : null}
    </div>}
  </section>
}
