import { useCallback, useRef, useState } from "react"
import type { SortingState } from "@tanstack/react-table"

import { useApi } from "@/hooks/use-api"
import { useQueueEvents, useQueueSnapshot } from "@/hooks/use-queue-events"
import { fetchSubagents, fetchThreadSubagents, watchRequestMetrics } from "@/lib/api"

/** The independent relationship page owns its metric notification subscription. */
export function useThreadSubagents(threadId?: string) {
  const [page, setPage] = useState<{ threadId?: string; offset: number; limit: number; sortKey: "time" | "last"; sortDirection: "asc" | "desc" }>({ threadId, offset: 0, limit: 20, sortKey: "last", sortDirection: "desc" })
  const offset = page.threadId === threadId ? page.offset : 0
  const sortKey = page.threadId === threadId ? page.sortKey : "last"
  const sortDirection = page.threadId === threadId ? page.sortDirection : "desc"
  const limit = page.threadId === threadId ? page.limit : 20
  const queryKey = JSON.stringify([threadId, offset, limit, sortKey, sortDirection])
  const requestedQuery = useRef(queryKey)
  const fetchSnapshot = useCallback(async (signal?: AbortSignal) => {
    requestedQuery.current = queryKey
    const query = { offset, limit, sortKey, sortDirection }
    return { queryKey, data: await (threadId === undefined ? fetchSubagents(query, signal) : fetchThreadSubagents(threadId, query, signal)) }
  }, [threadId, offset, limit, sortKey, sortDirection, queryKey])
  const { load, latest, read } = useQueueSnapshot(fetchSnapshot)
  const state = useApi(load, [queryKey])
  const notificationStatus = useQueueEvents(state.refetch, state.loading, offset === 0, latest, read, watchRequestMetrics)
  const error = requestedQuery.current === queryKey ? state.error : null
  const currentData = error === null && state.data?.queryKey === queryKey ? state.data.data : null
  const loading = error === null && currentData === null
  const refreshing = state.loading || loading
  const updatePage = (nextOffset: number) => setPage({ threadId, offset: nextOffset, limit, sortKey, sortDirection })

  return {
    data: currentData,
    error,
    errorCode: error === null ? null : state.errorCode,
    loading,
    refreshing,
    refetch: state.refetch,
    lastUpdatedAt: state.data?.queryKey === queryKey ? state.lastUpdatedAt : null,
    notificationStatus: offset > 0 ? "paused" as const : notificationStatus,
    pagination: {
      mode: "server" as const,
      pageNumber: Math.floor(offset / limit) + 1,
      pageSize: limit,
      pageSizeOptions: [10, 20, 50, 100],
      serverTotal: currentData?.total ?? 0,
      sorting: [{ id: sortKey, desc: sortDirection === "desc" }],
      enableSortingRemoval: false,
      onSortingChange: (next: SortingState) => {
        const sort = next[0]
        if (sort?.id !== "time" && sort?.id !== "last") return
        setPage({ threadId, offset: 0, limit, sortKey: sort.id, sortDirection: sort.desc ? "desc" : "asc" })
      },
      onPageSizeChange: (nextLimit: number) => {
        if (![10, 20, 50, 100].includes(nextLimit)) return
        setPage({ threadId, offset: 0, limit: nextLimit, sortKey, sortDirection })
      },
      hasPrevious: !refreshing && offset > 0,
      hasNext: !refreshing && currentData?.nextOffset != null,
      onPrevious: () => updatePage(Math.max(0, offset - limit)),
      onNext: () => { if (currentData?.nextOffset != null) updatePage(currentData.nextOffset) },
    },
  }
}
