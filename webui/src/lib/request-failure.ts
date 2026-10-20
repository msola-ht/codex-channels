import type { RequestRecord } from "./types"

const codeReasons = {
  rate_limit: "rateLimit", rate_limit_exceeded: "rateLimit", rate_limit_reached: "rateLimit",
  authentication_error: "authentication", permission_denied: "permission", payment_required: "payment",
  context_length_exceeded: "context", content_filter: "content", server_error: "server",
  upstream_timeout: "timeout", request_timeout: "timeout", upload_timeout: "timeout",
  preparation_timeout: "timeout", delivery_timeout: "timeout",
  invalid_request_error: "invalid", not_found: "notFound",
  web_search_unsupported: "webSearch",
  invalid_upstream_encoding: "invalidResponse", invalid_upstream_content_type: "invalidResponse",
  invalid_upstream_json: "invalidResponse", invalid_upstream_envelope: "invalidResponse", invalid_upstream_response: "invalidResponse",
  invalid_upstream_metadata: "invalidResponse", invalid_upstream_choices: "invalidResponse", invalid_upstream_message: "invalidResponse",
  invalid_upstream_tools: "invalidResponse", invalid_upstream_finish: "invalidResponse", invalid_upstream_usage: "invalidResponse",
  client_disconnected: "disconnected", client_delivery_error: "delivery", request_revoked: "revoked",
} as const

const httpReasons = {
  400: "invalid", 401: "authentication", 402: "payment", 403: "permission", 404: "notFound",
  408: "timeout", 429: "rateLimit", 500: "server", 502: "server", 503: "server", 504: "timeout",
} as const

/** Only controlled codes and actual HTTP status are classification evidence; raw upstream text is not. */
export function requestFailureReason(codes: readonly unknown[], httpStatus?: number | null) {
  for (const code of codes) {
    if (code === "web_search_unsupported" && httpStatus != null && httpStatus !== 200 && httpStatus !== 400) continue
    if (typeof code === "string" && Object.hasOwn(codeReasons, code)) return codeReasons[code as keyof typeof codeReasons]
  }
  if (typeof httpStatus === "number" && Object.hasOwn(httpReasons, httpStatus)) return httpReasons[httpStatus as keyof typeof httpReasons]
  if (typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500) return "invalid"
  if (codes.some(code => code === "chat_upstream_error" || code === "upstream_response_failed")) return "upstream"
  return undefined
}

export const failureLabelKeys = {
  rateLimit: "rateLimited", authentication: "authentication", permission: "permission", payment: "payment",
  context: "context", content: "filtered", server: "upstreamFailed", upstream: "upstreamFailed", timeout: "timeout",
  invalid: "rejected", notFound: "rejected", invalidResponse: "invalidResponse",
  webSearch: "webSearch",
  disconnected: "disconnected", delivery: "deliveryFailed", revoked: "revoked",
} as const

export function recordedRequestFailure(record: Pick<RequestRecord, "source" | "status" | "deliveryStatus" | "errorCode" | "errorType" | "httpStatus">) {
  if (record.status === "completed" && record.deliveryStatus === "disconnected") return "disconnected"
  if (record.status === "completed" && record.deliveryStatus === "failed") return "delivery"
  if (record.source === "relay") return requestFailureReason([record.errorCode], record.httpStatus)
  // Native metrics also carry upstream error fields. Local transport failures
  // retain priority; otherwise actual HTTP errors precede upstream identifiers.
  if (["upload_timeout", "preparation_timeout", "upstream_timeout", "delivery_timeout", "client_delivery_error", "client_disconnected"].includes(record.errorType ?? "")) {
    return requestFailureReason([record.errorType])
  }
  // A confirmed input-error subtype refines 400, but cannot override auth/rate-limit failures.
  if (record.errorCode === "web_search_unsupported" && (record.httpStatus == null || record.httpStatus === 200 || record.httpStatus === 400)) return "webSearch"
  const httpReason = requestFailureReason([], record.httpStatus)
  if (httpReason) return httpReason
  return requestFailureReason([record.errorCode === "client_disconnected" ? undefined : record.errorCode, record.errorType], record.httpStatus)
}
