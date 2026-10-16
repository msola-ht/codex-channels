import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useTranslation } from "@/hooks/use-translation"
import { formatCount, formatTokens, formatUsageTokens, formatTotalUsage } from "@/lib/format"
import type { CacheUsage, ReviewUsage, UsageCoverage } from "@/lib/types"

export function InputTokenTooltip({
  inputTokens,
  cachedInputTokens,
  cacheUsage,
  usageCoverage,
  requestCount,
}: {
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheUsage?: CacheUsage
  usageCoverage?: UsageCoverage
  requestCount?: number
}) {
  const { t } = useTranslation()
  const display = usageCoverage && requestCount !== undefined
    ? formatUsageTokens(inputTokens ?? 0, requestCount, usageCoverage.inputMissingRequestCount)
    : formatTokens(inputTokens)
  const knownCacheSubset = cachedInputTokens === null && cacheUsage?.cachedInputTokens != null
  const cached = knownCacheSubset ? cacheUsage.cachedInputTokens : cachedInputTokens
  if (cached === null || requestCount === 0 || display === "—") return <span className="tabular-nums">{display}</span>
  const knownInput = knownCacheSubset ? cacheUsage.inputTokens : inputTokens
  const uncached =
    knownInput === null
      ? null
      : Math.max(0, knownInput - cached)
  const cachedText = formatTokens(cached)
  const uncachedText = formatTokens(uncached)
  return (
    <Tooltip>
      <TooltipTrigger aria-description={[t("metrics.cached", { count: cachedText }), t("metrics.uncached", { count: uncachedText })].join("; ")} render={<span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>
          {display}
        </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          <li className="whitespace-nowrap">
            {t("metrics.cached", { count: cachedText })}
          </li>
          <li className="whitespace-nowrap">
            {t("metrics.uncached", { count: uncachedText })}
          </li>
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}

export function OutputTokenTooltip({
  outputTokens,
  reasoningOutputTokens,
  usageCoverage,
  requestCount,
}: {
  outputTokens: number | null
  reasoningOutputTokens: number | null
  usageCoverage?: UsageCoverage
  requestCount?: number
}) {
  const { t } = useTranslation()
  const display = usageCoverage && requestCount !== undefined
    ? formatUsageTokens(outputTokens ?? 0, requestCount, usageCoverage.outputMissingRequestCount)
    : formatTokens(outputTokens)
  if (outputTokens === null || requestCount === 0 || display === "—") return <span className="tabular-nums">{display}</span>
  const reasoning = reasoningOutputTokens ?? 0
  const details = [
    t("metrics.reasoning", { count: formatTokens(reasoning) }),
    t("metrics.nonReasoning", { count: formatTokens(Math.max(0, outputTokens - reasoning)) }),
  ]
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
  if (usage.requestCount === 0) return <span className="tabular-nums">{total}</span>
  const detail = t("metrics.reviewSubset", {
    count: formatCount(usage.requestCount),
    input: formatUsageTokens(usage.inputTokens, usage.requestCount, usage.usageCoverage.inputMissingRequestCount),
    output: formatUsageTokens(usage.outputTokens, usage.requestCount, usage.usageCoverage.outputMissingRequestCount),
  })
  return <Tooltip><TooltipTrigger aria-description={detail} render={<span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>{total}</TooltipTrigger><TooltipContent><ul className="flex flex-col gap-1">{detail.split("\n").map((line) => <li key={line} className="whitespace-nowrap">{line}</li>)}</ul></TooltipContent></Tooltip>
}
