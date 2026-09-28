import { Badge } from "@/components/ui/badge"
import { useTranslation } from "@/hooks/use-translation"

export function ProviderBadge({ provider }: { provider: string | null }) {
  const { t } = useTranslation()
  if (provider === null) return <Badge variant="outline">{t("common.unknown")}</Badge>
  return (
    <Badge variant={provider !== "openai" ? "secondary" : "outline"}>
      {provider}
    </Badge>
  )
}
