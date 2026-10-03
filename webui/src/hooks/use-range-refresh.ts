import { useContext, useEffect } from "react"
import { ServerTimeContext } from "@/hooks/use-server-time"
import { rangeRefreshAt, scheduleRangeRefresh } from "@/lib/range-refresh"
import type { MetricsRangeQuery } from "@/lib/types"

export function useRangeRefresh(query: MetricsRangeQuery, refetch: () => void, readStartedAt: number | null,
  blocked: boolean, calendarOverview = false) {
  const clock = useContext(ServerTimeContext)
  const { range, from, to } = query
  useEffect(() => {
    if (blocked || readStartedAt == null || clock === null) return
    const offset = clock.nowMs - clock.receivedAtMs
    const due = rangeRefreshAt({ range, from, to }, readStartedAt + offset, clock.timeZone, calendarOverview)
    if (due === null) return
    return scheduleRangeRefresh(refetch, due - offset, document, navigator, window)
  }, [range, from, to, refetch, readStartedAt, blocked, calendarOverview, clock])
}
