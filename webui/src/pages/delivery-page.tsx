import { DeliveryQueue } from "@/components/delivery/delivery-queue"
import { useTranslation } from "@/hooks/use-translation"

export function DeliveryPage() {
  const { t } = useTranslation()
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
    <div className="shrink-0">
      <h1 className="text-xl font-semibold">{t("delivery.title")}</h1>
      <p className="text-sm text-muted-foreground">{t("delivery.description")}</p>
    </div>
    <DeliveryQueue />
  </div>
}
