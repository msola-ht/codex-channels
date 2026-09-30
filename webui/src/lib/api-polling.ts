interface PageVisibility {
  readonly visibilityState: string
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

/** 页面恢复事件合并为一次补查；忙碌或节流期间保留，不做周期轮询。 */
export function scheduleVisibleSettingsRefresh(
  refresh: () => void,
  busy: boolean,
  page: PageVisibility,
  state: { pending: boolean; lastRefresh: number },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!state.pending || busy || page.visibilityState !== "visible") return
    const remaining = 5_000 - (Date.now() - state.lastRefresh)
    if (remaining > 0) {
      timer = setTimeout(flush, remaining)
      return
    }
    state.pending = false
    state.lastRefresh = Date.now()
    refresh()
  }
  const visible = () => {
    if (page.visibilityState === "visible") state.pending = true
    flush()
  }
  flush()
  page.addEventListener("visibilitychange", visible)
  return () => {
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", visible)
  }
}

export function scheduleApiRefresh(
  refresh: () => void,
  loading: boolean,
  enabled: boolean,
  page: PageVisibility,
  intervalMs = 2_000,
): () => void {
  if (loading || !enabled) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = undefined
    if (page.visibilityState === "visible") timer = setTimeout(refresh, intervalMs)
  }
  page.addEventListener("visibilitychange", schedule)
  schedule()
  return () => {
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", schedule)
  }
}

/** 首次读取仅建立基线；之后新出现或从运行态进入终态的任务触发关联刷新。 */
export function settledTaskIds(
  previous: ReadonlyMap<string, string> | null,
  tasks: readonly { id: string; state: string }[],
): string[] {
  if (previous === null) return []
  const terminal = (state: string | undefined) => state === "completed" || state === "failed" || state === "cancelled"
  return tasks.filter((task) => terminal(task.state) && !terminal(previous.get(task.id))).map((task) => task.id)
}
