import { Badge } from "@/components/ui/badge"
import { TableHint } from "@/components/metrics/data-table"

function normalizedTier(tier: string | null | undefined) {
  const value = tier?.toLowerCase()
  return value === "fast" || value === "priority" ? "fast" : value
}

export function FastBadge({ tier, source, responseTier }: {
  tier: string | null | undefined
  source: "request" | "response"
  responseTier?: string | null
}) {
  if (normalizedTier(tier) !== "fast") return null
  const hint = source === "request" && responseTier && normalizedTier(responseTier) !== "fast"
    ? `请求使用 Fast，响应回报层级：${responseTier}。`
    : null
  return <TableHint hint={hint}><Badge variant="secondary" className="h-4 px-1.5 py-0 text-[10px]">Fast</Badge></TableHint>
}
