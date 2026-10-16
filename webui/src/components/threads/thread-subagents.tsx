import { useMemo } from "react"
import { Link } from "react-router"

import { DataTable, SortableHeader, TableHint, TruncatedText, type DataTableColumn } from "@/components/metrics/data-table"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { ProviderBadge } from "@/components/metrics/provider-badge"
import { InputTokenTooltip, TokenHint } from "@/components/metrics/token-tooltip"
import { RefreshStatus } from "@/components/metrics/refresh-status"
import { QuerySummary } from "@/components/metrics/query-summary"
import { ModelUsageCards } from "@/components/metrics/model-usage-cards"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { useThreadSubagents } from "@/hooks/use-thread-subagents"
import { useTranslation } from "@/hooks/use-translation"
import { formatCacheUsage, formatElapsedDuration, formatModelName, formatRequestTime, formatTimestamp, getServerTimeZone, formatUsageTokens, shortThreadId } from "@/lib/format"
import { translateApiError } from "@/lib/i18n/translate"
import { metricsLink } from "@/lib/metrics-query"
import type { SubagentListItem } from "@/lib/types"

export function ThreadSubagents({ threadId, parentTurnId }: { threadId?: string; parentTurnId?: string }) {
  const { t } = useTranslation()
  const { data, loading, refreshing, error, errorCode, refetch, pagination, notificationStatus, lastUpdatedAt } = useThreadSubagents(threadId, parentTurnId)
  const global = threadId === undefined
  const summary = loading ? null : data?.summary
  const columnLabels = {
    time: t("threads.firstRequest"), agent: t("threads.subagent"), thread: t("metrics.thread"),
    parent: t("threads.parentThread"), provider: t("metrics.provider"), model: t("metrics.model"),
    reasoningEffort: t("metrics.reasoningEffort"),
    turns: t("metrics.turn"), requests: t("metrics.requests"), input: t("metrics.input"),
    cacheHitRate: t("metrics.cacheHitRate"), output: t("metrics.output"), last: t("metrics.last"),
    subagents: t("threads.directSubagents"),
    duration: t("threads.subagentDuration"), liveState: t("threads.subagentLiveState"),
    linkedTurns: t("threads.subagentLinkedTurns"),
  }
  const columns = useMemo<DataTableColumn<SubagentListItem>[]>(() => [
    { id: "time", accessorFn: agent => agent.firstRequestStartedAtMs, sortDescFirst: true,
      header: ({ column }) => <SortableHeader column={column}>{t("threads.firstRequest")}</SortableHeader>,
      cell: ({ row }) => row.original.firstRequestStartedAtMs == null ? "—" : <span className="whitespace-nowrap tabular-nums" title={`${formatTimestamp(row.original.firstRequestStartedAtMs)} · ${getServerTimeZone()}`}>{formatRequestTime(row.original.firstRequestStartedAtMs)}</span> },
    { id: "agent", enableSorting: false, header: t("threads.subagent"), cell: ({ row }) => {
      const agent = row.original
      const name = agent.agentPath.split("/").filter(Boolean).at(-1) ?? agent.agentPath
      return <Link to={metricsLink(`/threads/${encodeURIComponent(agent.threadId)}`, { range: "all" })} title={agent.agentPath} className="block max-w-36 truncate hover:underline">{name}</Link>
    } },
    { id: "thread", enableSorting: false, header: t("metrics.thread"), cell: ({ row }) => <Link
      to={metricsLink(`/threads/${encodeURIComponent(row.original.threadId)}`, { range: "all" })}
      title={row.original.threadId} className="hover:underline">{shortThreadId(row.original.threadId)}</Link> },
    ...(global ? [{ id: "parent", enableSorting: false, header: t("threads.parentThread"), cell: ({ row }) => <Link
      to={metricsLink(`/threads/${encodeURIComponent(row.original.parentThreadId)}`, { range: "all" })}
      title={row.original.parentThreadId} className="hover:underline">{shortThreadId(row.original.parentThreadId)}</Link> } satisfies DataTableColumn<SubagentListItem>] : []),
    { id: "liveState", enableSorting: false, header: () => <TableHint hint={t("threads.subagentLiveStateHint")}>{t("threads.subagentLiveState")}</TableHint>, cell: ({ row }) => {
      const state = row.original.liveState
      const badge = <Badge variant={state.status === "systemError" ? "destructive" : state.status === "active" ? "default" : "secondary"} size="sm">{t(`threads.subagentStatuses.${state.status}`)}</Badge>
      return state.status === "unknown" ? <TableHint hint={t(`threads.subagentStateReasons.${state.reason}`)}>{badge}</TableHint> : badge
    } },
    ...(parentTurnId === undefined ? [] : [{ id: "linkedTurns", enableSorting: false, header: () => <TableHint hint={t("threads.subagentLinkedTurnsHint")}>{t("threads.subagentLinkedTurns")}</TableHint>, cell: ({ row }) => {
      const agent = row.original
      if (agent.turnIds === null || agent.turnIds.length === 0) return "—"
      return <div className="flex flex-col items-start gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            {t("threads.subagentTurnLinks", { count: agent.turnIds.length })}
          </DropdownMenuTrigger>
          <DropdownMenuContent className="max-h-64 w-64">
            <DropdownMenuGroup>
              {agent.turnIds.map(turnId => <DropdownMenuItem key={turnId} render={<Link to={metricsLink("/requests", { range: "all", threadId: agent.threadId, turnId })} />}>
                <span className="truncate" title={turnId}>{turnId}</span>
              </DropdownMenuItem>)}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {agent.turnIdsTruncated ? <TableHint hint={t("threads.subagentTurnsTruncatedHint")}><span className="text-xs text-muted-foreground">{t("threads.subagentTurnsTruncated")}</span></TableHint> : null}
      </div>
    } } satisfies DataTableColumn<SubagentListItem>]),
    { id: "provider", enableSorting: false, header: t("metrics.provider"), cell: ({ row }) => <ProviderBadge provider={row.original.provider} /> },
    { id: "model", enableSorting: false, header: t("metrics.model"), cell: ({ row }) => <TruncatedText text={formatModelName(row.original.model, row.original.provider)} className="max-w-40" /> },
    { id: "reasoningEffort", enableSorting: false, header: t("metrics.reasoningEffort"), cell: ({ row }) => row.original.reasoningEffort ?? "—" },
    { id: "turns", enableSorting: false, header: t("metrics.turn"), cell: ({ row }) => row.original.turnCount },
    { id: "requests", enableSorting: false, header: t("metrics.requests"), cell: ({ row }) => row.original.requestCount },
    { id: "duration", enableSorting: false, header: () => <TableHint hint={t("threads.subagentDurationHint")}>{t("threads.subagentDuration")}</TableHint>, cell: ({ row }) => {
      const timing = row.original.executionTiming
      const partial = !timing.historyComplete || timing.missingDurationTurnCount > 0
      const hint = [
        t("threads.subagentDurationHint"),
        t("threads.subagentObservedTurns", { count: timing.observedTurnCount }),
        ...(timing.missingDurationTurnCount > 0 ? [t("threads.missingDurations", { count: timing.missingDurationTurnCount })] : []),
        ...(partial ? [t("threads.subagentDurationPartial")] : []),
      ].join(" ")
      return <TableHint hint={hint}><span className="tabular-nums">{timing.durationMs === null ? "—" : `${formatElapsedDuration(timing.durationMs)}${partial ? " *" : ""}`}</span></TableHint>
    } },
    { id: "input", enableSorting: false, header: () => <TableHint hint={t("metrics.input")}>{t("metrics.inputColumn")}</TableHint>, cell: ({ row }) => <InputTokenTooltip
      inputTokens={row.original.inputTokens}
      cachedInputTokens={row.original.cacheUsage.missingRequestCount > 0 ? null : row.original.cacheUsage.cachedInputTokens}
      cacheUsage={row.original.cacheUsage}
      requestCount={row.original.requestCount}
      usageCoverage={row.original.usageCoverage}
    /> },
    { id: "cacheHitRate", enableSorting: false, header: () => <TableHint hint={t("metrics.cacheScopeHint")}>{t("metrics.cacheHitRateColumn")}</TableHint>, cell: ({ row }) => formatCacheUsage(row.original.cacheUsage).rate },
    { id: "output", enableSorting: false, header: () => <TableHint hint={t("metrics.output")}>{t("metrics.outputColumn")}</TableHint>, cell: ({ row }) => <TokenHint value={formatUsageTokens(row.original.outputTokens, row.original.requestCount, row.original.usageCoverage.outputMissingRequestCount)} /> },
    { id: "last", accessorFn: agent => agent.lastRecordedAtMs, sortDescFirst: true,
      header: ({ column }) => <SortableHeader column={column}>{t("metrics.last")}</SortableHeader>,
      cell: ({ row }) => row.original.lastRecordedAtMs == null ? "—" : <span className="whitespace-nowrap tabular-nums" title={`${formatTimestamp(row.original.lastRecordedAtMs)} · ${getServerTimeZone()}`}>{formatRequestTime(row.original.lastRecordedAtMs)}</span> },
    { id: "subagents", enableSorting: false, header: t("threads.directSubagents"), cell: ({ row }) => row.original.directSubagentCount > 0 ? <Link
      to={`/threads/${encodeURIComponent(row.original.threadId)}/subagents`} className="hover:underline">
      <Badge variant="secondary" size="sm">{t("threads.subagentsCount", { count: row.original.directSubagentCount })}</Badge>
    </Link> : "—" },
  ], [global, parentTurnId, t])

  return <section aria-label={t(global ? "threads.allSubagents" : "threads.relatedSubagents")} aria-busy={refreshing} className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {global ? <h1 className="mr-auto text-xl font-semibold">{t("threads.allSubagents")}</h1> : null}
      <RefreshStatus status={notificationStatus} updatedAt={lastUpdatedAt} failed={error !== null} history={pagination.pageNumber > 1} />
      <Button variant="outline" size="sm" disabled={refreshing} onClick={refetch}>{refreshing ? t("common.refreshing") : t("common.refresh")}</Button>
    </div>
    <p className="shrink-0 text-sm text-muted-foreground">{t("threads.subagentLiveStateHint")}</p>
    <p className="shrink-0 text-sm text-muted-foreground">{t("metrics.conversationUsageScope")}</p>
    <ErrorBanner error={translateApiError(t, error, errorCode)} pending={refreshing} onRetry={refetch} />
    {error === null && !loading && data !== null && data.modelUsage.length > 0 ? <ModelUsageCards usage={data.modelUsage} /> : null}
    {error !== null ? null : <DataTable
      loading={loading}
      title={t(global ? "threads.allSubagents" : "threads.relatedSubagents")}
      description={({ total }) => <QuerySummary
        label={t("threads.subagentsTotal", { total })}
        range="all"
        scopeLabel={parentTurnId === undefined ? undefined : t("threads.subagentScopedSummary")}
        aggregate={summary ?? null}
        turns={summary?.turnCount}
        loading={loading}
      />}
      columns={columns}
      data={data?.subagents ?? []}
      getRowId={agent => agent.threadId}
      storageKey={global ? "codex-webui:all-subagents-table-v1" : "codex-webui:thread-subagents-table-v1"}
      columnLabels={columnLabels}
      numericColumnIds={["turns", "requests", "duration", "input", "cacheHitRate", "output", "subagents"]}
      emptyText={t("threads.subagentsEmpty")}
      pagination={pagination}
    />}
  </section>
}
