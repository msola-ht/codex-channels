import type { CacheUsage, RequestOutcomeCounts, RequestInterruptionSummary, RequestRecord, TrafficExchangeSummary } from "./types"
import { messages, type Translate } from "./i18n/messages"
import { translate } from "./i18n/translate"
import { failureLabelKeys, recordedRequestFailure } from "./request-failure"
import { formatGenerationSpeed as requestGenerationSpeed } from "../../../runtime/request-timing.mjs"

export function requestMethodDisplay(record: RequestRecord | TrafficExchangeSummary, t: Translate): { label: string; variant: "secondary" | "outline" } {
  if (record.requestPurpose === "autoApprovalReview") return { label: t("requestMethod.review"), variant: "secondary" }
  if (("operation" in record && record.operation === "compact") || ("requestKind" in record && record.requestKind === "compaction")) return { label: t("requestMethod.compact"), variant: "secondary" }
  if ("operation" in record && (record.operation === "imageGeneration" || record.operation === "imageEdit")) return { label: t(`requestMethod.${record.operation}`), variant: "secondary" }
  if (record.transport === "http" && "path" in record && record.method === "POST") {
    const path = record.path?.split(/[?#]/u)[0]
    if (path === "/images/generations") return { label: t("requestMethod.imageGeneration"), variant: "secondary" }
    if (path === "/images/edits") return { label: t("requestMethod.imageEdit"), variant: "secondary" }
  }
  return { label: record.transport === "websocket" ? "wss" : record.transport === "http" ? "http" : "—", variant: "outline" }
}

export function formatRequestActivity(record: RequestRecord | TrafficExchangeSummary, t: Translate): string {
  const method = requestMethodDisplay(record, t)
  const activity = record.activity
  const labels: string[] = []
  if (method.variant === "secondary") labels.push(method.label)
  else if ("category" in record && record.category === "models") labels.push(t("traffic.categoryModels"))
  else if ("category" in record && record.category === "prewarm") labels.push(t("traffic.categoryPrewarm"))
  if (activity?.toolResult) labels.push(t("traffic.activityToolResult"))
  if (activity?.reply) labels.push(t("traffic.activityReply"))
  if (activity?.toolCalls) labels.push(activity.tools.length ? `${t("traffic.activityTools")} · ${activity.tools.join(", ")}` : t("traffic.activityTools"))
  if (!labels.length) labels.push(t(activity == null ? "traffic.notRecorded" : "traffic.activityUnknown"))
  if (activity?.partial) labels.push(t("traffic.activityPartial"))
  return labels.join(" / ")
}

export function requestOperationLabel(operation: RequestRecord["operation"], t: Translate): string {
  if (operation === "imageGeneration" || operation === "imageEdit") return t(`requestMethod.${operation}`)
  return operation === "compact" ? t("metrics.compact") : t("filters.response")
}

/** Display recorded destinations without credentials, query parameters or fragments. */
export function formatTrafficRequestAddress(record: Pick<TrafficExchangeSummary, "transport" | "method" | "path" | "url">): string {
  const raw = record.transport === "websocket" ? record.url : record.path
  if (!raw) return "—"
  let address: string
  if (raw.startsWith("/") && !raw.startsWith("//")) {
    address = raw.split(/[?#]/u)[0]!
  } else {
    try {
      const url = new URL(raw)
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return "—"
      address = `${url.origin}${url.pathname}`
    } catch { return "—" }
  }
  return `${record.transport === "websocket" ? "WS" : record.method ?? "HTTP"} ${address}`
}

/** 调用转储使用 clp，请求指标使用精确账户 Provider clp-<id>。 */
export function isClinePassProvider(provider: string | null | undefined): boolean {
  return provider === "clp" || /^clp-[a-z0-9_-]{1,32}$/.test(provider ?? "")
}

export function formatModelName(model: string | null | undefined, provider: string | null | undefined): string | null {
  if (model == null) return null
  if (!isClinePassProvider(provider)) return model
  const prefix = `${provider}/`
  const unqualified = model.startsWith(prefix) ? model.slice(prefix.length) : model
  return unqualified.replace(/^cline-pass\//, "")
}

export type DisplayLanguage = "zh" | "en"

let serverTimeZone: string | undefined

/** 页面加载前由服务端时间接口设置；禁止静默使用浏览器时区。 */
export function setServerTimeZone(timeZone: string): void {
  if (!timeZone) throw new Error("服务端未提供时区")
  new Intl.DateTimeFormat("en", { timeZone }).format(0)
  serverTimeZone = timeZone
}

export function getServerTimeZone(): string {
  if (serverTimeZone === undefined) throw new Error("服务端时区尚未加载")
  return serverTimeZone
}

export function formatCalendarDay(value: number, timeZone = getServerTimeZone()): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(value)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

export function formatTimeZoneLabel(value: number): string {
  const timeZone = getServerTimeZone()
  const offset = new Intl.DateTimeFormat("en", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(value).find((part) => part.type === "timeZoneName")!.value.replace("GMT", "UTC")
  return `${timeZone}（${offset}）`
}

export function formatClockTime(value: number): string {
  const timeZone = getServerTimeZone()
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(value)
  return `${formatCalendarDay(value, timeZone)} ${time}`
}

const compactTwoDecimalFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 2,
})

const compactThreeDecimalFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  compactDisplay: "short",
  maximumFractionDigits: 3,
})

export function formatTokens(value: number | null | undefined): string {
  if (value == null || value === 0) return ""
  return Math.abs(value) >= 1_000_000_000
    ? compactThreeDecimalFormatter.format(value)
    : compactTwoDecimalFormatter.format(value)
}

/** Display recorded aggregate sums independently of coverage metadata. */
export function formatTotalUsage(value: { inputTokens: number; outputTokens: number }): string {
  return formatTokens(value.inputTokens + value.outputTokens)
}

export function formatCount(value: number): string {
  return value === 0 ? "" : compactTwoDecimalFormatter.format(value)
}

export function formatGenerationSpeed(value: Parameters<typeof requestGenerationSpeed>[0]): string {
  const display = requestGenerationSpeed(value)
  return display === "—" || display === "0.0 /s" ? "" : display
}

export function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(2)} MB`
}

export function formatTime(value: number | null | undefined, timeZone = getServerTimeZone()): string {
  if (value === null || value === undefined) return "—"
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(value)
  return `${formatCalendarDay(value, timeZone)} ${time}`
}

/** Request lists omit the year but retain seconds; full precision remains in details. */
export function formatRequestTime(value: number): string {
  return formatTimestamp(value).slice(5, -4)
}

/** Detail timestamps retain seconds and milliseconds in the server time zone. */
export function formatTimestamp(value: number, timeZone = getServerTimeZone()): string {
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23",
  }).format(value)
  return `${formatCalendarDay(value, timeZone)} ${time}`
}

const errorTypeNames: Record<string, { zh: string; en: string }> = {
  usage_limit_reached: { zh: "用量上限", en: "Usage limit" },
  service_unavailable_error: { zh: "服务暂不可用", en: "Service unavailable" },
  unknown_error: { zh: "未知错误", en: "Unknown error" },
  new_api_error: { zh: "上游 API 错误", en: "Upstream API error" },
  upstream_handshake_error: { zh: "上游握手失败", en: "Upstream handshake failed" },
  upstream_error: { zh: "上游错误", en: "Upstream error" },
  upstream_request_error: { zh: "上游请求失败", en: "Upstream request failed" },
  upstream_response_error: { zh: "上游响应失败", en: "Upstream response failed" },
  upstream_delivery_error: { zh: "上游请求交付失败", en: "Upstream request delivery failed" },
  client_request_error: { zh: "客户端请求失败", en: "Client request failed" },
  websocket_closed: { zh: "WebSocket 关闭", en: "WebSocket closed" },
  http_error: { zh: "HTTP 请求失败", en: "HTTP request failed" },
  response_not_observed: { zh: "响应未完整观测", en: "Response not fully observed" },
  turn_start_error: { zh: "Turn 启动失败", en: "Turn start failed" },
  turn_steer_error: { zh: "Turn 追加失败", en: "Turn steer failed" },
  turn_notification_error: { zh: "Turn 运行失败", en: "Turn failed" },
}

export function formatRequestError(record: Pick<RequestRecord, "source" | "status" | "deliveryStatus" | "errorCode" | "errorType" | "httpStatus" | "errorMessage">, language: DisplayLanguage): string {
  const reason = recordedRequestFailure(record)
  // Do not reclassify raw codes after the source-aware classifier rejected them.
  const localType = record.source === "relay" ? record.errorCode : record.errorType
  const label = localType && Object.hasOwn(errorTypeNames, localType) ? errorTypeNames[localType] : undefined
  const fallback = record.status === "incomplete" ? translate(language, "requests.relayReasons.incomplete")
    : record.status === "failed" ? translate(language, "requests.relayReasons.requestFailed")
    : record.status === "unknown" || record.errorType || record.errorCode || record.errorMessage ? translate(language, "requests.relayReasons.unknown") : "—"
  return reason ? translate(language, `requests.relayReasons.${failureLabelKeys[reason]}`)
    : label ? label[language] : fallback
}

export function formatTrafficFailureStage(stage: string, language: DisplayLanguage): string {
  const stages = messages[language].traffic.failureStages
  return Object.hasOwn(stages, stage) ? stages[stage as keyof typeof stages] : stages.unknown
}

const errorMessageTranslations: ReadonlyArray<{
  includes: string
  zh: string
  en: string
}> = [
  {
    includes: "Selected model is at capacity",
    zh: "所选模型当前容量已满，请稍后重试或改用其他模型。",
    en: "The selected model is currently at capacity. Please try again later or choose another model.",
  },
  {
    includes: "Our servers are currently overloaded",
    zh: "上游服务当前负载较高，请稍后重试。",
    en: "The upstream service is currently overloaded. Please try again later.",
  },
  {
    includes: "Responses websocket connection limit reached",
    zh: "Responses WebSocket 已达到连接时长上限，请新建连接后继续。",
    en: "The Responses WebSocket connection duration limit has been reached. Create a new connection to continue.",
  },
  {
    includes: "model is not supported when using Codex with a ChatGPT account",
    zh: "所选模型不支持通过 ChatGPT 账户使用 Codex，请切换受支持的模型。",
    en: "The selected model is not supported when using Codex with a ChatGPT account. Choose a supported model.",
  },
  {
    includes: "Insufficient Balance",
    zh: "账户余额不足，请充值后继续。",
    en: "The account balance is insufficient. Add funds to continue.",
  },
  {
    includes: "Invalid prompt:",
    zh: "提示词可能触发使用政策限制，请调整后重试。",
    en: "The prompt may have triggered a usage-policy restriction. Revise it and try again.",
  },
]

export function formatErrorMessage(value: string, language: DisplayLanguage): string {
  const message = value.replace(/\s+/gu, " ").trim()
  const translation = errorMessageTranslations.find((candidate) => {
    if (!message.includes(candidate.includes)) return false
    return candidate.includes !== "Invalid prompt:" || message.includes("usage policy")
  })
  if (translation) return translation[language]
  return value
}

export function formatSuccessRate(requestCount: number, unsuccessful: number): string {
  if (requestCount <= 0 || requestCount === unsuccessful) return ""
  return `${((requestCount - unsuccessful) / requestCount * 100).toFixed(1)}%`
}

export function formatFailureRate(requestCount: number, unsuccessful: number): string {
  if (requestCount <= 0 || unsuccessful === 0) return ""
  return `${(unsuccessful / requestCount * 100).toFixed(1)}%`
}

export function formatRequestOutcomes(outcomes: RequestOutcomeCounts | null, t: Translate): string {
  if (outcomes === null) return ""
  const categories: [string, number][] = [
    [t("filters.completed"), outcomes.completed],
    [t("metrics.interrupted"), outcomes.interrupted],
    [t("filters.failed"), outcomes.failed],
    [t("filters.incomplete"), outcomes.incomplete],
  ]
  return categories.filter(([, count]) => count !== 0).map(([label, count]) => `${label} ${formatCount(count)}`).join(" · ")
}

export function isClientInterruption(record: Pick<RequestRecord, "source" | "status" | "deliveryStatus" | "errorCode" | "errorType" | "httpStatus">): boolean {
  return record.status !== "completed" && (record.source === "relay" ? record.errorCode : record.errorType) === "client_disconnected"
}

export function formatInterruptionSummary(summary: RequestInterruptionSummary, t: Translate): string {
  return t("metrics.interruptionEvidence", {
    completed: formatCount(summary.followedByCompletion),
    unobserved: formatCount(summary.noObservedCompletion),
    usage: formatCount(summary.usageUnobserved),
  }).split(" · ").filter((_, index) => [summary.followedByCompletion, summary.noObservedCompletion, summary.usageUnobserved][index] !== 0).join(" · ")
}

export function shortThreadId(threadId: string): string {
  return threadId.length <= 14 ? threadId : `${threadId.slice(0, 8)}…${threadId.slice(-4)}`
}
export { formatElapsedDuration } from "../../../src/surfaces/elapsed-duration.js"

export function formatCacheUsage(usage: CacheUsage | null) {
  const cached = formatTokens(usage?.cachedInputTokens)
  const rate = usage !== null && usage.inputTokens > 0 && usage.cachedInputTokens !== null && usage.cachedInputTokens > 0
    ? `${(usage.cachedInputTokens / usage.inputTokens * 100).toFixed(1)}%`
    : ""
  return {
    cached,
    rate,
  }
}
