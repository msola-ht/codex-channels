import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  formatCost,
  formatCostDetail,
  type CostDetailFields,
  type DisplayCurrency,
} from "@/lib/format"

export type CostTooltipValue = CostDetailFields & {
  totalCostNanos: number | null
  totalCostCnyNanos?: number | null
}

export function CostTooltip({
  value,
  currency,
}: {
  value: CostTooltipValue
  currency?: DisplayCurrency | null
}) {
  const text = formatCost(value, currency)
  if (text === "—") {
    return <span className="tabular-nums">{text}</span>
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="tabular-nums cursor-help underline decoration-dotted decoration-muted-foreground/50 underline-offset-2">
          {text}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" align="start">
        <ul className="flex flex-col gap-1">
          {formatCostDetail(value, currency).map((item) => (
            <li key={item.label} className="whitespace-nowrap">
              {item.label}：{item.value}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  )
}
