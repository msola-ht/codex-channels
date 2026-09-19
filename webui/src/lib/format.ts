export type DisplayLanguage = "zh" | "en"

export function formatTokensPerSecond(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(2)
}

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
  if (value === null || value === undefined) return "—"
  return Math.abs(value) >= 1_000_000_000
    ? compactThreeDecimalFormatter.format(value)
    : compactTwoDecimalFormatter.format(value)
}

export function formatCount(value: number): string {
  return compactTwoDecimalFormatter.format(value)
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

const planTypeNames: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  self_serve_business_usage_based: "Business（按量）",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise（按量）",
  enterprise: "Enterprise",
  edu: "Edu",
  unknown: "未知",
}

export function formatPlanType(value: string | null): string {
  return value === null ? "未知" : (planTypeNames[value] ?? value)
}

const errorTypeNames: Record<string, { zh: string; en: string }> = {
  usage_limit_reached: { zh: "用量上限", en: "Usage limit" },
  rate_limit_reached: { zh: "速率限制", en: "Rate limit" },
  service_unavailable_error: { zh: "服务暂不可用", en: "Service unavailable" },
  invalid_request_error: { zh: "无效请求", en: "Invalid request" },
  unknown_error: { zh: "未知错误", en: "Unknown error" },
  new_api_error: { zh: "上游 API 错误", en: "Upstream API error" },
  upstream_handshake_error: { zh: "上游握手失败", en: "Upstream handshake failed" },
  upstream_error: { zh: "上游错误", en: "Upstream error" },
  upstream_request_error: { zh: "上游请求失败", en: "Upstream request failed" },
  upstream_response_error: { zh: "上游响应失败", en: "Upstream response failed" },
  client_request_error: { zh: "客户端请求失败", en: "Client request failed" },
  client_disconnected: { zh: "客户端断开", en: "Client disconnected" },
  websocket_closed: { zh: "WebSocket 关闭", en: "WebSocket closed" },
  http_error: { zh: "HTTP 请求失败", en: "HTTP request failed" },
  response_not_observed: { zh: "响应未完整观测", en: "Response not fully observed" },
  turn_start_error: { zh: "Turn 启动失败", en: "Turn start failed" },
  turn_steer_error: { zh: "Turn 追加失败", en: "Turn steer failed" },
  turn_notification_error: { zh: "Turn 运行失败", en: "Turn failed" },
}

export function formatErrorType(
  value: string | null,
  language: DisplayLanguage,
): string {
  if (value === null) return "—"
  const label = errorTypeNames[value]
  return label ? label[language] : value
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
  if (requestCount <= 0) return "—"
  return `${((requestCount - unsuccessful) / requestCount * 100).toFixed(1)}%`
}

export function formatFailureRate(requestCount: number, unsuccessful: number): string {
  if (requestCount <= 0) return "—"
  return `${(unsuccessful / requestCount * 100).toFixed(1)}%`
}

export function shortThreadId(threadId: string): string {
  return threadId.length <= 14 ? threadId : `${threadId.slice(0, 8)}…${threadId.slice(-4)}`
}
export { formatElapsedDuration } from "../../../src/surfaces/elapsed-duration.js"
