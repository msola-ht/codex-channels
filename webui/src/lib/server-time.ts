import type { ServerTimeResponse } from "./types"

export interface ServerClockSnapshot extends ServerTimeResponse {
  receivedAtMs: number
}

export function estimateServerTime(snapshot: ServerClockSnapshot, wallNow = Date.now()): number {
  return snapshot.nowMs + wallNow - snapshot.receivedAtMs
}

interface PageVisibility {
  readonly visibilityState: string
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

interface FocusTarget {
  addEventListener(type: "focus", listener: () => void): void
  removeEventListener(type: "focus", listener: () => void): void
}

export function observeServerClock(
  snapshot: ServerClockSnapshot,
  update: (nowMs: number) => void,
  page: PageVisibility,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined
  // Wall-clock elapsed time includes system sleep; the server baseline cancels fixed client clock skew.
  const tick = () => update(estimateServerTime(snapshot))
  const sync = () => {
    clearInterval(timer)
    timer = undefined
    if (page.visibilityState === "visible") {
      tick()
      timer = setInterval(tick, 1_000)
    }
  }
  page.addEventListener("visibilitychange", sync)
  sync()
  return () => {
    clearInterval(timer)
    page.removeEventListener("visibilitychange", sync)
  }
}

export function observeServerTimeResync(
  refresh: () => void,
  page: PageVisibility,
  focusTarget: FocusTarget,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = undefined
    // Focus and visibility commonly arrive together; coalesce them into one calibration.
    if (page.visibilityState === "visible") timer = setTimeout(refresh, 100)
  }
  page.addEventListener("visibilitychange", schedule)
  focusTarget.addEventListener("focus", schedule)
  return () => {
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", schedule)
    focusTarget.removeEventListener("focus", schedule)
  }
}
