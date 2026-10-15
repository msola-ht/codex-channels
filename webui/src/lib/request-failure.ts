import type { RequestRecord } from "./types"

const codeReasons = {
  rate_limit: "rateLimit", rate_limit_exceeded: "rateLimit", rate_limit_reached: "rateLimit",
  authentication_error: "authentication", permission_denied: "permission", payment_required: "payment",
  context_length_exceeded: "context", content_filter: "content", server_error: "server",
  chat_upstream_error: "server", upstream_response_failed: "server",
  upstream_timeout: "timeout", request_timeout: "timeout", upload_timeout: "timeout",
  preparation_timeout: "timeout", delivery_timeout: "timeout",
  invalid_request_error: "invalid", not_found: "notFound",
  invalid_upstream_encoding: "invalidResponse", invalid_upstream_content_type: "invalidResponse",
  invalid_upstream_json: "invalidResponse", invalid_upstream_envelope: "invalidResponse", invalid_upstream_response: "invalidResponse",
  client_disconnected: "disconnected", client_delivery_error: "delivery", request_revoked: "revoked",
} as const

const httpReasons = {
  400: "invalid", 401: "authentication", 402: "payment", 403: "permission", 404: "notFound",
  408: "timeout", 429: "rateLimit", 500: "server", 502: "server", 503: "server", 504: "timeout",
} as const

/** Only controlled codes and actual HTTP status are classification evidence; raw upstream text is not. */
export function requestFailureReason(codes: readonly unknown[], httpStatus?: number | null) {
  for (const code of codes) {
    if (typeof code === "string" && Object.hasOwn(codeReasons, code)) return codeReasons[code as keyof typeof codeReasons]
  }
  if (typeof httpStatus === "number" && Object.hasOwn(httpReasons, httpStatus)) return httpReasons[httpStatus as keyof typeof httpReasons]
  if (typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500) return "invalid"
  return undefined
}

export const failureLabelKeys = {
  rateLimit: "rateLimited", authentication: "authentication", permission: "permission", payment: "payment",
  context: "context", content: "filtered", server: "upstreamFailed", timeout: "timeout",
  invalid: "rejected", notFound: "rejected", invalidResponse: "invalidResponse",
  disconnected: "disconnected", delivery: "deliveryFailed", revoked: "revoked",
} as const

export function recordedRequestFailure(record: Pick<RequestRecord, "source" | "status" | "deliveryStatus" | "errorCode" | "errorType" | "httpStatus">) {
  if (record.status === "completed" && record.deliveryStatus === "disconnected") return "disconnected"
  if (record.status === "completed" && record.deliveryStatus === "failed") return "delivery"
  if (record.source !== "relay") {
    // Native metrics also carry upstream error fields. Local transport failures
    // retain priority; otherwise actual HTTP errors precede upstream identifiers.
    if (["upload_timeout", "preparation_timeout", "upstream_timeout", "delivery_timeout", "client_delivery_error", "client_disconnected"].includes(record.errorType ?? "")) {
      return requestFailureReason([record.errorType])
    }
    const httpReason = requestFailureReason([], record.httpStatus)
    if (httpReason) return httpReason
  }
  return requestFailureReason([record.errorCode, record.errorType], record.httpStatus)
}
