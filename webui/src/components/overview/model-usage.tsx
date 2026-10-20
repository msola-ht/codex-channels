import { useId, useState } from "react"
import { ModelUsageCards } from "@/components/metrics/model-usage-cards"
import { Button } from "@/components/ui/button"
import { useTranslation } from "@/hooks/use-translation"
import type { ModelUsage } from "@/lib/types"

const collapsedModelCount = 8

export function ModelUsageSection({ models }: { models: ModelUsage[] }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const cardsId = useId()
  if (models.length === 0) return null

  return <section className="flex flex-col gap-3" aria-label={t("overview.byModel")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">{t("overview.byModel")}</h2>
      {models.length > collapsedModelCount ? <Button variant="outline" size="sm"
        aria-expanded={expanded} aria-controls={cardsId} onClick={() => setExpanded(previous => !previous)}>
        {expanded ? t("overview.collapseModels") : t("overview.expandModels", { count: models.length })}
      </Button> : null}
    </div>
    <div id={cardsId}>
      <ModelUsageCards usage={expanded ? models : models.slice(0, collapsedModelCount)} />
    </div>
  </section>
}
