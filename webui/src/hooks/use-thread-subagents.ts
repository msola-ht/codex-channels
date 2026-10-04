import { useCallback, useRef, useState } from "react"

import { useApi } from "@/hooks/use-api"
import { fetchThreadSubagents } from "@/lib/api"

/** Uses the owning thread page's snapshot revision; never opens another SSE subscription. */
export function useThreadSubagents(threadId: string, revision?: unknown) {
  const [page, setPage] = useState<{ threadId: string; offset: number; sortKey: "time" | "last"; sortDirection: "asc" | "desc" }>({ threadId, offset: 0, sortKey: "last", sortDirection: "desc" })
  const offset = page.threadId === threadId ? page.offset : 0
  const sortKey = page.threadId === threadId ? page.sortKey : "last"
  const sortDirection = page.threadId === threadId ? page.sortDirection : "desc"
  const limit = 20
  const queryKey = JSON.stringify([threadId, offset, sortKey, sortDirection])
  const requestedQuery = useRef(queryKey)
  const load = useCallback(async (signal: AbortSignal) => {
    requestedQuery.current = queryKey
    return { queryKey, data: await fetchThreadSubagents(threadId, { offset, limit, sortKey, sortDirection }, signal) }
  }, [threadId, offset, limit, sortKey, sortDirection, queryKey])
  const state = useApi(load, [queryKey, offset > 0 ? null : revision])
  const error = requestedQuery.current === queryKey ? state.error : null
  const currentData = error === null && state.data?.queryKey === queryKey ? state.data.data : null
  const loading = error === null && currentData === null
  const refreshing = state.loading || loading
  const updatePage = (nextOffset: number) => setPage({ threadId, offset: nextOffset, sortKey, sortDirection })

  return {
    data: currentData,
    error,
    errorCode: error === null ? null : state.errorCode,
    loading,
    refreshing,
    refetch: state.refetch,
    sorting: {
      sortKey,
      sortDirection,
      onSort: (key: "time" | "last") => setPage({ threadId, offset: 0, sortKey: key, sortDirection: key === sortKey && sortDirection === "desc" ? "asc" : "desc" }),
    },
    pagination: {
      pageNumber: Math.floor(offset / limit) + 1,
      hasPrevious: !refreshing && offset > 0,
      hasNext: !refreshing && currentData?.nextOffset != null,
      onPrevious: () => updatePage(Math.max(0, offset - limit)),
      onNext: () => { if (currentData?.nextOffset != null) updatePage(currentData.nextOffset) },
    },
  }
}
