import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { formatTokens } from "@/lib/format"

export function InputTokenTooltip({
  inputTokens,
  cachedInputTokens,
}: {
  inputTokens: number | null
  cachedInputTokens: number | null
}) {
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
        <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
          {formatTokens(inputTokens)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          <li className="whitespace-nowrap">
            命中缓存：{formatTokens(cachedInputTokens)}
          </li>
          <li className="whitespace-nowrap">
            未命中缓存：{uncached === null ? "—" : formatTokens(uncached)}
          </li>
          <li className="whitespace-nowrap">
            命中率：
            {rate === null ? "—" : `${(rate * 100).toFixed(1)}%`}
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
  const nonReasoning =
    outputTokens === null || reasoningOutputTokens === null
      ? null
      : Math.max(0, outputTokens - reasoningOutputTokens)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
          {formatTokens(outputTokens)}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          <li className="whitespace-nowrap">
            推理输出：{formatTokens(reasoningOutputTokens)}
          </li>
          <li className="whitespace-nowrap">
            非推理输出：{nonReasoning === null ? "—" : formatTokens(nonReasoning)}
          </li>
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
