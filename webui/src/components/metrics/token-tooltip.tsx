import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useTranslation } from "@/hooks/use-translation"
import { formatTokens } from "@/lib/format"

export function InputTokenTooltip({
  inputTokens,
  cachedInputTokens,
}: {
  inputTokens: number | null
  cachedInputTokens: number | null
}) {
  const { t } = useTranslation()
  if (cachedInputTokens === null) return <span className="tabular-nums">{formatTokens(inputTokens)}</span>
  const uncached =
    inputTokens === null || cachedInputTokens === null
      ? null
      : Math.max(0, inputTokens - cachedInputTokens)
  const rate =
    inputTokens !== null
      && inputTokens > 0
      && cachedInputTokens !== null
      ? cachedInputTokens / inputTokens
      : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">
          {formatTokens(inputTokens)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          <li className="whitespace-nowrap">
            {t("metrics.cached", { count: formatTokens(cachedInputTokens) })}
          </li>
          <li className="whitespace-nowrap">
            {t("metrics.uncached", { count: uncached === null ? "—" : formatTokens(uncached) })}
          </li>
          <li className="whitespace-nowrap">
            {t("metrics.hitRate", { rate: rate === null ? "—" : `${(rate * 100).toFixed(1)}%` })}
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
      <TooltipTrigger asChild>
        <span tabIndex={0} className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">
          {formatTokens(outputTokens)}
        </span>
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
