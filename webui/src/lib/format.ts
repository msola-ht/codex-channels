interface CostFields {
  totalCostNanos: number | null
  totalCostCnyNanos?: number | null
  pricingCurrency: string | null
  pricing?: { currency?: string | null } | null
}

export type DisplayCurrency = "cny" | "usd"
export type DisplayLanguage = "zh" | "en"

function money(nanos: number, currency: string): string {
  const amount = nanos / 1_000_000_000
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `
  const digits = amount >= 100 ? 2 : amount >= 1 ? 3 : 4
  return `${symbol}${amount.toFixed(digits)}`
}

export function formatCost(
  value: CostFields,
  currency?: DisplayCurrency | null,
): string {
  const pricingCurrency = value.pricingCurrency ?? value.pricing?.currency ?? null
  if (currency === "cny" && value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined) {
    return money(value.totalCostCnyNanos, "CNY")
  }
  if (currency === "usd" && value.totalCostNanos !== null && pricingCurrency === "USD") {
    return money(value.totalCostNanos, "USD")
  }
  if (currency === "cny") {
    return value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined
      ? money(value.totalCostCnyNanos, "CNY")
      : value.totalCostNanos === null || pricingCurrency === null
        ? "—"
        : money(value.totalCostNanos, pricingCurrency)
  }
  if (value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined) {
    return money(value.totalCostCnyNanos, "CNY")
  }
  if (value.totalCostNanos === null || pricingCurrency === null) {
    return "—"
  }
  return money(value.totalCostNanos, pricingCurrency)
}

export interface CostDetailFields {
  pricingCurrency: string | null
  pricing?: { currency?: string | null } | null
  inputCostNanos?: number | null
  uncachedInputCostNanos?: number | null
  cachedInputCostNanos: number | null
  outputCostNanos: number | null
  inputCostCnyNanos?: number | null
  cachedInputCostCnyNanos?: number | null
  outputCostCnyNanos?: number | null
}

export function formatCostDetail(
  value: CostDetailFields,
  currency?: DisplayCurrency | null,
): { label: string; value: string }[] {
  const pricingCurrency = value.pricingCurrency ?? value.pricing?.currency ?? null
  const pick = (
    nanos: number | null | undefined,
    cnyNanos: number | null | undefined,
  ): string => {
    if (nanos === null || nanos === undefined) return "—"
    if (currency === "cny" && cnyNanos !== null && cnyNanos !== undefined) {
      return money(cnyNanos, "CNY")
    }
    return pricingCurrency === null
      ? "—"
      : money(nanos, pricingCurrency)
  }
  const inputNanos = value.inputCostNanos ?? value.uncachedInputCostNanos ?? null
  return [
    { label: "输入", value: pick(inputNanos, value.inputCostCnyNanos) },
    {
      label: "缓存",
      value: pick(value.cachedInputCostNanos, value.cachedInputCostCnyNanos),
    },
    { label: "输出", value: pick(value.outputCostNanos, value.outputCostCnyNanos) },
  ]
}

export function formatAvgPer100M(
  value: CostFields & { inputTokens: number | null; outputTokens: number },
  currency?: DisplayCurrency | null,
): string {
  const totalTokens = (value.inputTokens ?? 0) + value.outputTokens
  if (totalTokens <= 0 || value.totalCostNanos === null) return "—"
  const autoCny = value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined
  const targetCny = currency === "cny"
    || ((currency === undefined || currency === null) && autoCny)
  const cnyNanos = targetCny ? value.totalCostCnyNanos ?? null : null
  const targetCurrency = cnyNanos !== null
    ? "CNY"
    : currency === "usd"
      ? "USD"
      : value.pricingCurrency
  const nanos = cnyNanos ?? value.totalCostNanos
  if (nanos === null || targetCurrency === null) return "—"
  const avg = nanos / 1_000_000_000 / totalTokens * 100_000_000
  const symbol = targetCurrency === "CNY" ? "¥" : targetCurrency === "USD" ? "$" : `${targetCurrency} `
  return `${symbol}${avg.toFixed(2)}/100M`
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (value >= 100_000_000) {
    const n = value / 100_000_000
    return `${Number.isInteger(n) ? n : n.toFixed(2)}亿`
  }
  if (value >= 10_000) {
    const n = value / 10_000
    return `${Number.isInteger(n) ? n : n.toFixed(1)}万`
  }
  return value.toLocaleString("zh-CN")
}

export function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}分`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}秒`
  return `${Math.round(value)}毫秒`
}

export function formatSpeed(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${value.toFixed(1)} tok/s`
}

export function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
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

export function shortThreadId(threadId: string): string {
  return threadId.length <= 14 ? threadId : `${threadId.slice(0, 8)}…${threadId.slice(-4)}`
}
