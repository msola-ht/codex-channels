import { Badge } from "@/components/ui/badge"
import { normalizeServiceTier } from "../../../../runtime/service-tier.mjs"
import { TableHint } from "@/components/metrics/data-table"
import { useTranslation } from "@/hooks/use-translation"

function normalizedTier(tier: string | null | undefined) {
  return normalizeServiceTier(tier?.toLowerCase())
}

export function AccelerationBadge({ tier, source, responseTier }: {
  tier: string | null | undefined
  source: "request" | "response"
  responseTier?: string | null
}) {
  const { t } = useTranslation()
  const acceleration = normalizedTier(tier)
  if (acceleration !== "fast" && acceleration !== "ultrafast") return null
  const label = t(acceleration === "fast" ? "settingsFields.fast" : "settingsFields.ultrafast")
  const hint = source === "request" && responseTier && normalizedTier(responseTier) !== acceleration
    ? t("metrics.serviceTierMismatch", { requested: label, tier: responseTier })
    : null
  return <TableHint hint={hint}><Badge variant="secondary" size="sm">{label}</Badge></TableHint>
}
