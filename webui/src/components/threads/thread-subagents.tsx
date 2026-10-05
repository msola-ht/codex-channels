import { useMemo } from "react"
import { Link } from "react-router"

import { DataTable, SortableHeader, TableHint, TruncatedText, type DataTableColumn } from "@/components/metrics/data-table"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { InputTokenTooltip } from "@/components/metrics/token-tooltip"
import { RefreshStatus } from "@/components/metrics/refresh-status"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useThreadSubagents } from "@/hooks/use-thread-subagents"
import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatModelName, formatTime, formatTokens, shortThreadId } from "@/lib/format"
import { translateApiError } from "@/lib/i18n/translate"
import { metricsLink } from "@/lib/metrics-query"
import type { SubagentListItem } from "@/lib/types"

export function ThreadSubagents({ threadId, parentTurnId }: { threadId?: string; parentTurnId?: string }) {
  const { t } = useTranslation()
  const { data, loading, refreshing, error, errorCode, refetch, pagination, notificationStatus, lastUpdatedAt } = useThreadSubagents(threadId, parentTurnId)
  const global = threadId === undefined
  const columnLabels = {
    time: t("threads.firstRequest"), agent: t("threads.subagent"), thread: t("metrics.thread"),
    parent: t("threads.parentThread"), provider: t("metrics.provider"), model: t("metrics.model"),
    reasoningEffort: t("metrics.reasoningEffort"),
    turns: t("metrics.turn"), requests: t("metrics.requests"), input: t("metrics.input"),
    cacheHitRate: t("metrics.cacheHitRate"), output: t("metrics.output"), last: t("metrics.last"),
    subagents: t("threads.directSubagents"),
  }
  const columns = useMemo<DataTableColumn<SubagentListItem>[]>(() => [
    { id: "time", accessorFn: agent => agent.firstRequestStartedAtMs, sortDescFirst: true,
      header: ({ column }) => <SortableHeader column={column}>{t("threads.firstRequest")}</SortableHeader>,
      cell: ({ row }) => row.original.firstRequestStartedAtMs == null ? "—" : formatTime(row.original.firstRequestStartedAtMs) },
    { id: "agent", enableSorting: false, header: t("threads.subagent"), cell: ({ row }) => {
      const agent = row.original
      const name = agent.agentPath.split("/").filter(Boolean).at(-1) ?? agent.agentPath
      return <Link to={metricsLink(`/threads/${encodeURIComponent(agent.threadId)}`, { range: "all" })} title={agent.agentPath} className="block max-w-64 truncate hover:underline">{name}</Link>
    } },
    { id: "thread", enableSorting: false, header: t("metrics.thread"), cell: ({ row }) => <Link
      to={metricsLink(`/threads/${encodeURIComponent(row.original.threadId)}`, { range: "all" })}
      title={row.original.threadId} className="hover:underline">{shortThreadId(row.original.threadId)}</Link> },
    ...(global ? [{ id: "parent", enableSorting: false, header: t("threads.parentThread"), cell: ({ row }) => <Link
      to={metricsLink(`/threads/${encodeURIComponent(row.original.parentThreadId)}`, { range: "all" })}
      title={row.original.parentThreadId} className="hover:underline">{shortThreadId(row.original.parentThreadId)}</Link> } satisfies DataTableColumn<SubagentListItem>] : []),
    { id: "provider", enableSorting: false, header: t("metrics.provider"), cell: ({ row }) => <ProviderBadge provider={row.original.provider} /> },
    { id: "model", enableSorting: false, header: t("metrics.model"), cell: ({ row }) => <TruncatedText text={formatModelName(row.original.model, row.original.provider)} className="max-w-40" /> },
    { id: "reasoningEffort", enableSorting: false, header: t("metrics.reasoningEffort"), cell: ({ row }) => row.original.reasoningEffort ?? "—" },
    { id: "turns", enableSorting: false, header: t("metrics.turn"), cell: ({ row }) => row.original.turnCount },
    { id: "requests", enableSorting: false, header: t("metrics.requests"), cell: ({ row }) => row.original.requestCount },
    { id: "input", enableSorting: false, header: () => <TableHint hint={t("metrics.input")}>{t("metrics.inputColumn")}</TableHint>, cell: ({ row }) => <InputTokenTooltip
      inputTokens={row.original.inputTokens}
      cachedInputTokens={row.original.cacheUsage.missingRequestCount > 0 ? null : row.original.cacheUsage.cachedInputTokens}
      cacheUsage={row.original.cacheUsage}
    /> },
    { id: "cacheHitRate", enableSorting: false, header: () => <TableHint hint={t("metrics.cacheHitRate")}>{t("metrics.cacheHitRateColumn")}</TableHint>, cell: ({ row }) => formatCacheUsage(row.original.cacheUsage).rate },
    { id: "output", enableSorting: false, header: () => <TableHint hint={t("metrics.output")}>{t("metrics.outputColumn")}</TableHint>, cell: ({ row }) => formatTokens(row.original.outputTokens) },
    { id: "last", accessorFn: agent => agent.lastRecordedAtMs, sortDescFirst: true,
      header: ({ column }) => <SortableHeader column={column}>{t("metrics.last")}</SortableHeader>,
      cell: ({ row }) => row.original.lastRecordedAtMs == null ? "—" : formatTime(row.original.lastRecordedAtMs) },
    { id: "subagents", enableSorting: false, header: t("threads.directSubagents"), cell: ({ row }) => row.original.directSubagentCount > 0 ? <Link
      to={`/threads/${encodeURIComponent(row.original.threadId)}/subagents`} className="hover:underline">
      <Badge variant="secondary" size="sm">{t("threads.subagentsCount", { count: row.original.directSubagentCount })}</Badge>
    </Link> : "—" },
  ], [global, t])

  return <section aria-label={t(global ? "threads.allSubagents" : "threads.relatedSubagents")} aria-busy={refreshing} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      <RefreshStatus status={notificationStatus} updatedAt={lastUpdatedAt} failed={error !== null} history={pagination.pageNumber > 1} />
      <Button variant="outline" size="sm" disabled={refreshing} onClick={refetch}>{refreshing ? t("common.refreshing") : t("common.refresh")}</Button>
    </div>
    <ErrorBanner error={translateApiError(t, error, errorCode)} pending={refreshing} onRetry={refetch} />
    {error === null && !loading && data !== null && data.modelUsage.length > 0 ? <section aria-label={t("metrics.model")} className="grid shrink-0 grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {data.modelUsage.map(usage => <Card key={JSON.stringify(usage.model)} size="sm">
        <CardHeader><CardTitle><TruncatedText text={formatModelName(usage.model, null)} /></CardTitle></CardHeader>
        <CardContent>
          <dl className="grid grid-cols-3 gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-sm text-muted-foreground">{t("metrics.input")}</dt>
              <dd className="text-xl font-semibold tabular-nums"><InputTokenTooltip
                inputTokens={usage.inputTokens}
                cachedInputTokens={usage.cacheUsage.missingRequestCount > 0 ? null : usage.cacheUsage.cachedInputTokens}
                cacheUsage={usage.cacheUsage}
              /></dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-sm text-muted-foreground">{t("metrics.cacheHitRate")}</dt>
              <dd className="text-xl font-semibold tabular-nums">{formatCacheUsage(usage.cacheUsage).rate}</dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-sm text-muted-foreground">{t("metrics.output")}</dt>
              <dd className="text-xl font-semibold tabular-nums">{formatTokens(usage.outputTokens)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>)}
    </section> : null}
    {error !== null ? null : <DataTable
      loading={loading}
      title={t(global ? "threads.allSubagents" : "threads.relatedSubagents")}
      description={({ total }) => <>{t("threads.subagentsTotal", { total })} · {t("threads.subagentMetricsHint")}</>}
      columns={columns}
      data={data?.subagents ?? []}
      getRowId={agent => agent.threadId}
      storageKey={global ? "codex-webui:all-subagents-table-v1" : "codex-webui:thread-subagents-table-v1"}
      columnLabels={columnLabels}
      numericColumnIds={["turns", "requests", "input", "cacheHitRate", "output", "subagents"]}
      emptyText={t("threads.subagentsEmpty")}
      pagination={pagination}
    />}
  </section>
}
