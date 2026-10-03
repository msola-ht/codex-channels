import { formatCalendarDay } from "./format"
import type { MetricsRangeQuery } from "./types"

/** Find a calendar boundary in the server zone, including 23/25-hour DST days. */
export function nextCalendarDay(now: number, timeZone: string): number {
  const day = formatCalendarDay(now, timeZone)
  let low = now, high = now + 48 * 60 * 60 * 1000
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (formatCalendarDay(middle, timeZone) === day) low = middle
    else high = middle
  }
  return high
}

export function rangeRefreshAt(query: MetricsRangeQuery, readStartedAt: number, timeZone: string, calendarOverview = false): number | null {
  const range = query.from === undefined && query.to === undefined ? query.range : undefined
  const rolling = range !== undefined && ["24h", "7d", "30d", "90d"].includes(range)
  const calendar = calendarOverview || range === "today" || range === "yesterday"
  if (!rolling && !calendar) return null
  return Math.min(rolling ? readStartedAt + 300_000 : Infinity, calendar ? nextCalendarDay(readStartedAt, timeZone) : Infinity)
}

/** No requests while hidden/offline. A missed deadline produces one catch-up read. */
export function scheduleRangeRefresh(refresh: () => void, due: number, page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  network: Pick<Navigator, "onLine">, events: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let fired = false
  const schedule = () => {
    clearTimeout(timer)
    if (fired || page.visibilityState !== "visible" || !network.onLine) return
    timer = setTimeout(() => { fired = true; refresh() }, Math.max(250, due - Date.now()))
  }
  page.addEventListener("visibilitychange", schedule)
  events.addEventListener("online", schedule)
  events.addEventListener("offline", schedule)
  schedule()
  return () => {
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", schedule)
    events.removeEventListener("online", schedule)
    events.removeEventListener("offline", schedule)
  }
}
