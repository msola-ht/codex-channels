export type RangeName = "24h" | "7d" | "30d"

export interface Range {
  name: RangeName
  startAtMs: number
  endAtMs: number
}

export interface CompactSummary {
  model: string | null
  hasMixedModels: boolean
  requestCount: number
  unsuccessfulRequestCount: number
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
  pricingCurrency: string | null
  pricedRequestCount: number
  totalCostNanos: number | null
  totalCostCnyNanos?: number | null
}

export interface Aggregate {
  requestCount: number
  unsuccessfulRequestCount: number
  requestDurationMs: number
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
  reasoningOutputTokens: number
  outputTokensPerSecond: number | null
  outputSpeedSampleCount: number
  outputSpeedTimedCount: number
  ttftAverageMs: number | null
  ttftP50Ms: number | null
  ttftP95Ms: number | null
  pricingCurrency: string | null
  pricedRequestCount: number
  totalCostNanos: number | null
  inputCostNanos: number | null
  cachedInputCostNanos: number | null
  outputCostNanos: number | null
  hasMixedPrices: boolean
  compact: CompactSummary | null
  totalCostCnyNanos?: number | null
  inputCostCnyNanos?: number | null
  cachedInputCostCnyNanos?: number | null
  outputCostCnyNanos?: number | null
}

export interface ProviderGroup {
  provider: string | null
  model: string | null
  aggregate: Aggregate
}

export interface ErrorGroup {
  provider: string | null
  model: string | null
  status: string
  httpStatus: number | null
  errorType: string | null
  lastErrorMessage: string | null
  requestCount: number
  lastOccurredAtMs: number
}

export interface ErrorsReport {
  startAtMs: number
  endAtMs: number
  requestCount: number
  unsuccessfulRequestCount: number
  groups: ErrorGroup[]
  totalGroupCount: number
}

export interface WeeklyQuota {
  limitId: string
  /** ChatGPT 账户套餐等级（free/plus/pro/team 等），来自上游 plan_type */
  planType: string | null
  usedPercent: number
  remainingPercent: number
  /** 下次重置时间（毫秒 Unix 时间戳） */
  resetsAt: number
  observedAtMs: number
  estimate: {
    observedDeltaPercent: number
    intervalCount: number
    requestCount: number
    unsuccessfulRequestCount: number
    pricedRequestCount: number
    inputTokensPerPercent: number
    outputTokensPerPercent: number
    totalTokensPerPercent: number
    pricingCurrency: string | null
    costPerPercentNanos: number | null
  } | null
}

export interface OverviewResponse {
  range: Range
  generatedAt: string
  global: Aggregate | null
  providers: ProviderGroup[]
  errors: ErrorsReport
  weeklyQuota: WeeklyQuota | null
}

export interface ThreadListItem {
  threadId: string
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  turnCount: number
  requestCount: number
  inputTokens: number
  outputTokens: number
  pricingCurrency: string | null
  pricedRequestCount: number
  totalCostNanos: number | null
  compact: CompactSummary | null
  firstRequestStartedAtMs: number
  lastRecordedAtMs: number
  totalCostCnyNanos?: number | null
}

export interface ThreadsResponse {
  generatedAt: string
  threads: ThreadListItem[]
}

export interface TurnSummary {
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  turnId: string
  requestCount: number
  unsuccessfulRequestCount: number
  requestDurationMs: number
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
  reasoningOutputTokens: number
  outputTokensPerSecond: number | null
  pricingCurrency: string | null
  pricedRequestCount: number
  totalCostNanos: number | null
  inputCostNanos: number | null
  cachedInputCostNanos: number | null
  outputCostNanos: number | null
  uncachedInputPricePerMillionNanos: number | null
  cachedInputPricePerMillionNanos: number | null
  outputPricePerMillionNanos: number | null
  hasMixedPrices: boolean
  totalCostCnyNanos?: number | null
  inputCostCnyNanos?: number | null
  cachedInputCostCnyNanos?: number | null
  outputCostCnyNanos?: number | null
  compact: CompactSummary | null
  recordedAtMs?: number
}

export interface ThreadRunResponse {
  generatedAt: string
  threadId: string
  latestTurn: TurnSummary | null
  threadAggregate: (Aggregate & { turnCount: number }) | null
  latestDirectApi: RequestRecord | null
}

export interface ThreadTurnsResponse {
  generatedAt: string
  threadId: string
  turns: TurnSummary[]
}

export interface RequestRecord {
  id: number
  provider: string | null
  model: string | null
  pricing?: {
    billingMode: string | null
    currency: string | null
    source: string | null
    effectiveAtMs: number | null
    uncachedInputPricePerMillionNanos: number | null
    cachedInputPricePerMillionNanos: number | null
    outputPricePerMillionNanos: number | null
  } | null
  operation: "response" | "compact"
  status: string
  httpStatus: number | null
  errorType: string | null
  errorCode: string | null
  errorMessage: string | null
  transport: string
  responseFormat: string
  serviceTier: string | null
  reasoningEffort: string | null
  threadId: string | null
  turnId: string | null
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
  requestDurationMs: number | null
  ttftMs: number | null
  thinkingDurationMs: number | null
  outputDurationMs: number | null
  generationDurationMs: number | null
  cacheHitRate: number | null
  outputTokensPerSecond: number | null
  pricingCurrency: string | null
  pricedRequestCount?: number
  totalCostNanos: number | null
  totalCostCnyNanos?: number | null
  uncachedInputCostNanos: number | null
  cachedInputCostNanos: number | null
  outputCostNanos: number | null
  inputCostCnyNanos?: number | null
  cachedInputCostCnyNanos?: number | null
  outputCostCnyNanos?: number | null
  recordedAtMs: number
}

export type RequestSortKey =
  | "time"
  | "provider"
  | "model"
  | "operation"
  | "status"
  | "http"
  | "error"
  | "input"
  | "output"
  | "reasoningOutput"
  | "speed"
  | "ttft"
  | "duration"
  | "cost"

export type RequestSortDirection = "asc" | "desc"

export interface RequestsResponse {
  range: Range
  generatedAt: string
  records: RequestRecord[]
  nextOffset: number | null
  /** 当前筛选条件下匹配的记录总数（未筛选时等于时间范围内全部记录数） */
  total: number
}

export interface ErrorsResponse {
  range: Range
  generatedAt: string
  errors: ErrorsReport
}

export interface SettingsResponse {
  /** 当前全局显示币种（跟随 config.toml 的 display.price_currency） */
  currency: "cny" | "usd"
  exchangeRate: {
    usdToCny: number
    effectiveAtMs: number
    source: "open-er-api" | "ecb" | "cache"
  } | null
}

export interface DeepseekBalance {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

export interface DeepseekBalanceResponse {
  available: boolean
  balances: DeepseekBalance[]
}
