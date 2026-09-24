interface PageVisibility {
  readonly visibilityState: string
  addEventListener(type: "visibilitychange", listener: () => void): void
  removeEventListener(type: "visibilitychange", listener: () => void): void
}

export function scheduleApiRefresh(
  refresh: () => void,
  loading: boolean,
  enabled: boolean,
  page: PageVisibility,
): () => void {
  if (loading || !enabled) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = () => {
    clearTimeout(timer)
    timer = undefined
    if (page.visibilityState === "visible") timer = setTimeout(refresh, 2_000)
  }
  page.addEventListener("visibilitychange", schedule)
  schedule()
  return () => {
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", schedule)
  }
}
