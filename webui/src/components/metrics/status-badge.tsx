import { Badge } from "@/components/ui/badge"
import { useTranslation } from "@/hooks/use-translation"
import type { MessageKey } from "@/lib/i18n/messages"

/** 已记录的请求状态映射到字典键；未知状态保留上游原值。 */
const statusKeys: Readonly<Record<string, MessageKey>> = {
  completed: "status.completed",
  failed: "status.failed",
  incomplete: "status.incomplete",
}

export function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation()
  const variant = status === "completed"
    ? "default"
    : status === "failed"
      ? "destructive"
      : status === "incomplete"
        ? "outline"
        : "secondary"
  const key = statusKeys[status]
  return <Badge variant={variant}>{key === undefined ? status : t(key)}</Badge>
}
