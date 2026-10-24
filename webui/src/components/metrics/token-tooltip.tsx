import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useTranslation } from "@/hooks/use-translation"
import { formatCount, formatTokens, formatTotalUsage } from "@/lib/format"
import type { CacheUsage, ReviewUsage } from "@/lib/types"

export function InputTokenTooltip({
  inputTokens,
  cachedInputTokens,
  cacheUsage,
  requestCount,
}: {
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheUsage?: CacheUsage
  requestCount?: number
}) {
  const { t } = useTranslation()
  const display = formatTokens(inputTokens)
  const knownCacheSubset = cachedInputTokens === null && cacheUsage?.cachedInputTokens != null
  const cached = knownCacheSubset ? cacheUsage.cachedInputTokens : cachedInputTokens
  if (cached === null || requestCount === 0 || !display) return <span className="tabular-nums">{display}</span>
  const knownInput = knownCacheSubset ? cacheUsage.inputTokens : inputTokens
  const uncached =
    knownInput === null
      ? null
      : Math.max(0, knownInput - cached)
  const cachedText = formatTokens(cached)
  const uncachedText = formatTokens(uncached)
  const details = [
    cachedText ? t("metrics.cached", { count: cachedText }) : "",
    uncachedText ? t("metrics.uncached", { count: uncachedText }) : "",
  ].filter(Boolean)
  if (details.length === 0) return <span className="tabular-nums">{display}</span>
  return (
    <Tooltip>
      <TooltipTrigger aria-description={details.join("; ")} render={<span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>
          {display}
        </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          {details.map(detail => <li key={detail} className="whitespace-nowrap">{detail}</li>)}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

export function OutputTokenTooltip({
  outputTokens,
  reasoningOutputTokens,
  requestCount,
}: {
  outputTokens: number | null
  reasoningOutputTokens: number | null
  requestCount?: number
}) {
  const { t } = useTranslation()
  const display = formatTokens(outputTokens)
  if (outputTokens === null || requestCount === 0 || !display) return <span className="tabular-nums">{display}</span>
  const reasoning = reasoningOutputTokens ?? 0
  const details = [
    reasoning > 0 ? t("metrics.reasoning", { count: formatTokens(reasoning) }) : "",
    outputTokens > reasoning ? t("metrics.nonReasoning", { count: formatTokens(outputTokens - reasoning) }) : "",
  ].filter(Boolean)
  if (details.length === 0) return <span className="tabular-nums">{display}</span>
  return (
    <Tooltip>
      <TooltipTrigger aria-description={details.join("; ")} render={<span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>
          {display}
        </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          {details.map((detail) => <li key={detail} className="whitespace-nowrap">{detail}</li>)}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

export function TokenHint({ value }: { value: string }) {
  return <span className="tabular-nums">{value}</span>
}

export function ReviewUsageSummary({ usage }: { usage: ReviewUsage }) {
  const { t } = useTranslation()
  const total = formatTotalUsage(usage)
  if (usage.requestCount === 0 || !total) return <span className="tabular-nums">{total}</span>
  const detail = t("metrics.reviewSubset", {
    count: formatCount(usage.requestCount),
    input: formatTokens(usage.inputTokens),
    output: formatTokens(usage.outputTokens),
  }).split("\n").filter((_, index) => [usage.requestCount, usage.inputTokens, usage.outputTokens][index] !== 0).join("\n")
  return <Tooltip><TooltipTrigger aria-description={detail} render={<span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>{total}</TooltipTrigger><TooltipContent><ul className="flex flex-col gap-1">{detail.split("\n").map((line) => <li key={line} className="whitespace-nowrap">{line}</li>)}</ul></TooltipContent></Tooltip>
}
