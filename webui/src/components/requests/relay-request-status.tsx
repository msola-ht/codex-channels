import { StatusBadge } from "@/components/metrics/status-badge"
import { useTranslation } from "@/hooks/use-translation"
import type { RequestRecord } from "@/lib/types"

/** Historical evidence only: never infer a request's outcome from current service settings. */
function reason(record: RequestRecord) {
  if (record.errorCode === "client_disconnected") return "disconnected"
  if (record.errorCode === "request_revoked") return "revoked"
  if (record.errorCode === "upstream_timeout" || record.errorCode === "request_timeout") return "timeout"
  if (record.errorCode === "rate_limit" || record.httpStatus === 429) return "rateLimited"
  if (record.errorCode?.startsWith("invalid_upstream_")) return "invalidResponse"
  if (record.errorCode === "authentication_error") return "authentication"
  if (record.errorCode === "payment_required") return "payment"
  if (record.errorCode === "permission_denied") return "permission"
  if (record.errorCode === "context_length_exceeded") return "context"
  if (record.errorCode === "content_filter") return "filtered"
  if (record.httpStatus !== null && record.httpStatus >= 400 && record.httpStatus < 500) return "rejected"
  if (["server_error", "chat_upstream_error", "upstream_response_failed"].includes(record.errorCode ?? "")) return "upstreamFailed"
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
