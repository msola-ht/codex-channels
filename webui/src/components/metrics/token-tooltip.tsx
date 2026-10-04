import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useTranslation } from "@/hooks/use-translation"
import { formatTokens } from "@/lib/format"
import type { CacheUsage } from "@/lib/types"

export function InputTokenTooltip({
  inputTokens,
  cachedInputTokens,
  cacheUsage,
}: {
  inputTokens: number | null
  cachedInputTokens: number | null
  cacheUsage?: CacheUsage
}) {
  const { t } = useTranslation()
  const partial = cachedInputTokens === null && cacheUsage?.cachedInputTokens != null
  const cached = partial ? cacheUsage.cachedInputTokens : cachedInputTokens
  if (cached === null) return <span className="tabular-nums">{formatTokens(inputTokens)}</span>
  const knownInput = partial ? cacheUsage.inputTokens : inputTokens
  const uncached =
    knownInput === null
      ? null
      : Math.max(0, knownInput - cached)
  const cachedText = `${partial ? "≥ " : ""}${formatTokens(cached)}`
  const uncachedText = uncached === null ? "—" : `${partial ? "≥ " : ""}${formatTokens(uncached)}`
  return (
    <Tooltip>
      <TooltipTrigger aria-description={[t("metrics.cached", { count: cachedText }), t("metrics.uncached", { count: uncachedText })].join("; ")} render={<span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring" />}>
          {formatTokens(inputTokens)}
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
}: {
  outputTokens: number | null
  reasoningOutputTokens: number | null
}) {
  const { t } = useTranslation()
  if (reasoningOutputTokens === null) return <span className="tabular-nums">{formatTokens(outputTokens)}</span>
  const nonReasoning =
    outputTokens === null || reasoningOutputTokens === null
      ? null
      : Math.max(0, outputTokens - reasoningOutputTokens)
  return (
    <Tooltip>
      <TooltipTrigger aria-description={[t("metrics.reasoning", { count: formatTokens(reasoningOutputTokens) }), t("metrics.nonReasoning", { count: nonReasoning === null ? "—" : formatTokens(nonReasoning) })].join("; ")} render={<span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2" />}>
          {formatTokens(outputTokens)}
        </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          <li className="whitespace-nowrap">
            {t("metrics.reasoning", { count: formatTokens(reasoningOutputTokens) })}
          </li>
          <li className="whitespace-nowrap">
            {t("metrics.nonReasoning", { count: nonReasoning === null ? "—" : formatTokens(nonReasoning) })}
          </li>
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
