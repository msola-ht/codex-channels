export type RangeName =
  | "today" | "yesterday"
  | "this-week" | "last-week"
  | "this-month" | "last-month"
  | "24h" | "7d" | "30d" | "90d" | "365d" | "all"

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
  agentPath: string | null
  parentThreadId: string | null
  parentTurnId: string | null
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
  agentPath: string | null
  parentThreadId: string | null
  parentTurnId: string | null
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
  /** 按发生时间倒序的单条失败请求。 */
  records: RequestRecord[]
  nextOffset: number | null
  total: number
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

export interface SettingsSummaryResponse {
  observedAt: string
  revision: string
  gateway: {
    display: {
      operationUpdates: "full" | "compact" | "hidden"
      planUpdatesEnabled: boolean
      reasoningEnabled: boolean
      priceCurrency: "cny" | "usd"
    }
    system: {
      approvalTimeoutSeconds: number
      sandbox: "read-only" | "workspace-write"
      defaultWorkspace: string | null
      defaultModel: string | null
    }
    automation: { scheduledTasksEnabled: boolean; threadSectionAdministratorCount: number }
    network: { configuredFields: string[] }
    advanced: {
      loggingLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace"
      pluginApiEnabled: boolean
    }
    webui: { host: string; port: number; tokenConfigured: boolean }
    metrics: {
      storage: { retentionDays: number; maxRows: number }
      sync: { enabled: boolean; endpointConfigured: boolean; deviceName: string | null; deviceTokenConfigured: boolean }
      view: { enabled: boolean; endpointConfigured: boolean; tokenConfigured: boolean }
      center: {
        enabled: boolean
        host: string
        port: number
        tokenConfigured: boolean
        deviceTokenConfigured: boolean
      }
    }
    channels: Array<{ id: "telegram" | "feishu" | "weixin"; displayName: string; configured: true; enabled: boolean }>
  }
  services: {
    available: boolean
    platform: "systemd" | "launchd" | "windows" | null
    healthy: boolean | null
    entries: Array<{
      target: string
      name: string
      loaded: boolean
      running: boolean
      state: string
      pid: number | null
    }>
  }
  cli: Array<{ id: string; label: string; command: string; detail: string }>
}

export interface ManagementSettingsResponse {
  revision: string
  display: SettingsSummaryResponse["gateway"]["display"]
  system: Pick<SettingsSummaryResponse["gateway"]["system"], "approvalTimeoutSeconds" | "sandbox" | "defaultModel">
  automation: { scheduledTasksEnabled: boolean }
  advanced: { loggingLevel: SettingsSummaryResponse["gateway"]["advanced"]["loggingLevel"] }
  metrics: {
    storage: SettingsSummaryResponse["gateway"]["metrics"]["storage"]
    sync: { enabled: boolean; intervalSeconds: number; batchSize: number }
  }
  webui: { host: string; port: number }
}

export interface ManagementSettingInput { kind: string; value: unknown }
export interface ManagementLoginResponse { expiresAt: number; csrfToken: string }
export interface ManagementSettingMutationResponse {
  revision: string
  value: unknown
  activation: { status: string; target: string; commands: readonly string[] }
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

export interface OpencodeGoQuotaWindow {
  windowId: string
  label: string
  usedPercent: number
  resetsAt: number | null
  status: string | null
  totalUsd?: number
  localTokens?: number | null
}

export interface ModelUsageEstimate {
  model: string
  bucket?: "off-peak" | "peak"
  includedUsageUsd: number
  usedUsdNanos: number | null
  usedPercent: number | null
  remainingUsdNanos: number | null
  windowStartAtMs: number | null
  windowEndAtMs: number | null
}

export type OpencodeGoModelUsageEstimate = ModelUsageEstimate

export interface OpencodeGoAccountUsage {
  account: string
  displayName: string
  default: boolean
  available: boolean
  windows: OpencodeGoQuotaWindow[]
  modelUsage: ModelUsageEstimate[]
}

export interface OpencodeGoUsageResponse {
  accounts: OpencodeGoAccountUsage[]
}

export interface OfficialAccountSnapshot {
  provider: string
  accountId: string | null
  observedAtMs: number
  available: boolean
  usage: unknown
  limits: unknown
}

export interface OfficialAccountSnapshotsResponse {
  observedAtMs: number
  snapshots: OfficialAccountSnapshot[]
}

export interface GlobalTotals {
  device_count: number
  request_count: number
  subagent_count: number
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
  last_recorded_at_ms: number | null
}

export interface GlobalCostRow {
  currency: string
  request_count: number
  total_cost_nanos: number
}

export interface GlobalProviderRow {
  provider: string | null
  provider_display_name?: string | null
  provider_email?: string | null
  provider_phone?: string | null
  request_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
  models?: GlobalProviderModelRow[]
}

export interface GlobalProviderModelRow {
  model: string | null
  request_count: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export interface GlobalOverviewResponse {
  totals: GlobalTotals | null
  costsByCurrency: GlobalCostRow[]
  providers: GlobalProviderRow[]
}

export interface GlobalDeviceRow {
  device_id: string
  display_name: string
  first_seen_at_ms: number
  last_seen_at_ms: number
  last_ingested_at_ms: number | null
  request_count: number
  total_tokens: number
  costs_by_currency: GlobalCostRow[]
  subagent_count: number
}

export interface GlobalDevicesResponse {
  devices: GlobalDeviceRow[]
}

export interface GlobalDailyRow {
  day: string
  request_count: number
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  reasoning_output_tokens: number
  total_tokens: number
  total_cost_nanos: number
}

export interface GlobalDailyResponse {
  daily: GlobalDailyRow[]
}

export interface GlobalQuotaPeriod {
  provider: string
  providerDisplayName?: string | null
  windowId: string
  resetsAt: number
  /** 根据额度窗口推导的周期起点；无法识别窗口长度时为 null。 */
  periodStartAtMs: number | null
  /** 当前周期为计划重置时刻；历史周期提前重置时为下一周期的真实起点。 */
  periodEndAtMs: number
  /** 本地指标首次观测到该周期的时刻，不参与周期边界展示。 */
  firstObservedAtMs: number
  /** 本地指标最后观测到该周期的时刻。 */
  lastObservedAtMs: number
  deviceCount: number
  requestCount: number
  unsuccessfulRequestCount: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  totalCostNanos: number
  pricedRequestCount: number
  latestUsedPercentMillionths: number | null
  observedDeltaPercentMillionths: number
  tokensPerPercent: number | null
  costPerPercentNanos: number | null
  /** 按观测到的额度增量外推到 100% 的估算值。 */
  estimatedTotalTokens: number | null
  estimatedTotalCostNanos: number | null
}

export interface GlobalQuotaResponse {
  days: number | "all"
  generatedAt: string
  periods: GlobalQuotaPeriod[]
}

export interface GlobalRequestRow {
  device_id: string
  local_id: number
  recorded_at_ms: number
  provider: string | null
  model: string | null
  status: string | null
  operation: string | null
  input_tokens: number | null
  cached_input_tokens: number | null
  output_tokens: number | null
  reasoning_output_tokens: number | null
  total_tokens: number | null
  cache_hit_rate: number | null
  pricing_currency: string | null
  total_cost_nanos: number | null
}

export interface GlobalRequestsResponse {
  requests: GlobalRequestRow[]
  total: number
}
