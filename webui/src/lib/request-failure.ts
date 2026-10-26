import type { RequestRecord } from "./types"

const hostedSearchReasons = {
  olc_search_authentication_error: "olcSearchAuthentication", olc_search_permission_denied: "olcSearchPermission",
  olc_search_rate_limit: "olcSearchRateLimit", olc_search_timeout: "olcSearchTimeout", olc_search_deadline: "olcSearchDeadline",
  olc_search_invalid_response: "olcSearchInvalidResponse", olc_search_upstream_error: "olcSearchUpstream", olc_search_failed: "olcSearchFailed",
  clp_search_authentication_error: "clpSearchAuthentication", clp_search_permission_denied: "clpSearchPermission",
  clp_search_payment_required: "clpSearchPayment", clp_search_rate_limit: "clpSearchRateLimit",
  clp_search_timeout: "clpSearchTimeout", clp_search_invalid_response: "clpSearchInvalidResponse",
  clp_search_upstream_error: "clpSearchUpstream", clp_search_cancelled: "clpSearchCancelled",
  clp_search_limit: "clpSearchLimit", clp_search_output_limit: "clpSearchOutputLimit",
  clp_search_unsupported_controls: "clpSearchUnsupportedControls", clp_search_mixed_tools: "clpSearchMixedTools",
  clp_search_tool_choice: "clpSearchToolChoice",
} as const

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

function hostedSearchFailureReason(codes: readonly unknown[]) {
  for (const code of codes) {
    if (typeof code === "string" && Object.hasOwn(hostedSearchReasons, code)) return hostedSearchReasons[code as keyof typeof hostedSearchReasons]
  }
  return undefined
}

/** Only controlled codes and actual HTTP status are classification evidence; raw upstream text is not. */
export function requestFailureReason(codes: readonly unknown[], httpStatus?: number | null) {
  if (codes.includes("client_disconnected")) return "disconnected"
  const searchReason = hostedSearchFailureReason(codes)
  if (searchReason) return searchReason
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
  olcSearchAuthentication: "olcSearchAuthentication", olcSearchPermission: "olcSearchPermission",
  olcSearchRateLimit: "olcSearchRateLimit", olcSearchTimeout: "olcSearchTimeout", olcSearchDeadline: "olcSearchDeadline",
  olcSearchInvalidResponse: "olcSearchInvalidResponse", olcSearchUpstream: "olcSearchUpstream", olcSearchFailed: "olcSearchFailed",
  rateLimit: "rateLimited", authentication: "authentication", permission: "permission", payment: "payment",
  context: "context", content: "filtered", server: "upstreamFailed", upstream: "upstreamFailed", timeout: "timeout",
  invalid: "rejected", notFound: "rejected", invalidResponse: "invalidResponse",
  webSearch: "webSearch",
  clpSearchAuthentication: "clpSearchAuthentication", clpSearchPermission: "clpSearchPermission",
  clpSearchPayment: "clpSearchPayment", clpSearchRateLimit: "clpSearchRateLimit",
  clpSearchTimeout: "clpSearchTimeout", clpSearchInvalidResponse: "clpSearchInvalidResponse",
  clpSearchUpstream: "clpSearchUpstream", clpSearchCancelled: "clpSearchCancelled",
  clpSearchLimit: "clpSearchLimit", clpSearchOutputLimit: "clpSearchOutputLimit",
  clpSearchUnsupportedControls: "clpSearchUnsupportedControls", clpSearchMixedTools: "clpSearchMixedTools",
  clpSearchToolChoice: "clpSearchToolChoice",
  disconnected: "disconnected", delivery: "deliveryFailed", revoked: "revoked",
} as const

export function recordedRequestFailure(record: Pick<RequestRecord, "source" | "status" | "deliveryStatus" | "errorCode" | "errorType" | "httpStatus">) {
  if (record.status === "completed" && record.deliveryStatus === "disconnected") return "disconnected"
  if (record.status === "completed" && record.deliveryStatus === "failed") return "delivery"
  if (record.source === "relay") return requestFailureReason([record.errorCode], record.httpStatus)
  // Native metrics also carry upstream error fields. Local transport failures
  // retain priority; otherwise actual HTTP errors precede generic upstream identifiers.
  if (["upload_timeout", "preparation_timeout", "upstream_timeout", "delivery_timeout", "client_delivery_error", "client_disconnected"].includes(record.errorType ?? "")) {
    return requestFailureReason([record.errorType])
  }
  // Confirmed hosted-search failures refine the outer model HTTP result.
  const searchReason = hostedSearchFailureReason([record.errorCode, record.errorType])
  if (searchReason) return searchReason
  // A confirmed input-error subtype refines 400, but cannot override auth/rate-limit failures.
  if (record.errorCode === "web_search_unsupported" && (record.httpStatus == null || record.httpStatus === 200 || record.httpStatus === 400)) return "webSearch"
  const httpReason = requestFailureReason([], record.httpStatus)
  if (httpReason) return httpReason
  return requestFailureReason([record.errorCode === "client_disconnected" ? undefined : record.errorCode, record.errorType], record.httpStatus)
}
