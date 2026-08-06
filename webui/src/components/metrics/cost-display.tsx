import { formatAvgPer100M, formatCost } from "@/lib/format"
import type { Aggregate } from "@/lib/types"

export function CostDisplay({ value }: { value: Aggregate | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-medium tabular-nums">{formatCost(value)}</span>
      <span className="text-xs text-muted-foreground">
        均价 {formatAvgPer100M(value)}
      </span>
    </span>
  )
}
