import { StatusBadge } from "@/components/metrics/status-badge"
import { useTranslation } from "@/hooks/use-translation"
import type { RequestRecord } from "@/lib/types"
import { recordedRequestFailure, failureLabelKeys } from "@/lib/request-failure"

/** Historical evidence only: never infer a request's outcome from current service settings. */
function reason(record: RequestRecord) {
  const classified = recordedRequestFailure(record)
  if (classified) return failureLabelKeys[classified]
  if (record.status === "failed" || record.errorCode) return "requestFailed"
  if (record.deliveryStatus === "disconnected") return "disconnected"
  if (record.deliveryStatus === "failed") return "deliveryFailed"
  if (record.status === "incomplete") return "incomplete"
  return undefined
}

export function RelayRequestStatus({ record }: { record: RequestRecord }) {
  const { t } = useTranslation()
  const label = reason(record)
  return <div className="flex flex-col items-start gap-1">
    <StatusBadge status={record.status} />
    {label && <span className="max-w-48 whitespace-normal text-xs text-muted-foreground">{t(`requests.relayReasons.${label}`)}</span>}
  </div>
}
