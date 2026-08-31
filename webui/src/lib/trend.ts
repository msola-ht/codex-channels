export interface UsageTrendSourceRow {
  day: string
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
}

export interface StackedUsageTrendRow {
  day: string
  uncachedInputTokens: number
  cachedInputTokens: number
  nonReasoningOutputTokens: number
  reasoningOutputTokens: number
}

function splitIncludedTokens(total: number, included: number): [number, number] {
  const safeTotal = Math.max(0, total)
  const safeIncluded = Math.min(Math.max(0, included), safeTotal)
  return [safeTotal - safeIncluded, safeIncluded]
}

export function toStackedUsageTrend(rows: UsageTrendSourceRow[]): StackedUsageTrendRow[] {
  return rows.map((row) => {
    const [uncachedInputTokens, cachedInputTokens] = splitIncludedTokens(
      row.inputTokens,
      row.cachedInputTokens,
    )
    const [nonReasoningOutputTokens, reasoningOutputTokens] = splitIncludedTokens(
      row.outputTokens,
      row.reasoningOutputTokens,
    )
    return {
      day: row.day.slice(5),
      uncachedInputTokens,
      cachedInputTokens,
      nonReasoningOutputTokens,
      reasoningOutputTokens,
    }
  })
}

export function positionTrendTooltip(
  point: readonly number[],
  contentSize: readonly number[],
  viewSize: readonly number[],
): [number, number] {
  const offset = 12
  const pointerX = point[0] ?? 0
  const pointerY = point[1] ?? 0
  const contentWidth = contentSize[0] ?? 0
  const contentHeight = contentSize[1] ?? 0
  const viewWidth = viewSize[0] ?? 0
  const viewHeight = viewSize[1] ?? 0
  const x = pointerX + contentWidth + offset <= viewWidth
    ? pointerX + offset
    : Math.max(0, pointerX - contentWidth - offset)
  const y = Math.min(
    Math.max(0, pointerY + offset),
    Math.max(0, viewHeight - contentHeight),
  )
  return [x, y]
}
