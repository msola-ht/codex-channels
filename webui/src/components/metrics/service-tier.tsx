import { Badge } from "@/components/ui/badge"
import { TableHint } from "@/components/metrics/data-table"
import { useTranslation } from "@/hooks/use-translation"

function normalizedTier(tier: string | null | undefined) {
  const value = tier?.toLowerCase()
  return value === "fast" || value === "priority" ? "fast" : value
}

export function FastBadge({ tier, source, responseTier }: {
  tier: string | null | undefined
  source: "request" | "response"
  responseTier?: string | null
}) {
  const { t } = useTranslation()
  if (normalizedTier(tier) !== "fast") return null
  const hint = source === "request" && responseTier && normalizedTier(responseTier) !== "fast"
    ? t("metrics.fastMismatch", { tier: responseTier })
    : null
  return <TableHint hint={hint}><Badge variant="secondary" size="sm">Fast</Badge></TableHint>
}
