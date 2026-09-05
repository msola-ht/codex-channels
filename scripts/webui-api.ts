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

export interface ManagementServiceEntry {
  target: "gateway" | "app-server" | "webui" | "center"
  name: string
  identifier: string | null
  loaded: boolean
  running: boolean
  state: string
  pid: number | null
  version: string | null
  recentError: { message: string; observedAt: string | null } | null
}

export interface ManagementServicesResponse {
  observedAt: string
  available: boolean
  platform: "systemd" | "launchd" | "windows" | null
  healthy: boolean | null
  entries: ManagementServiceEntry[]
}

export interface ManagementProviderEntry {
  id: string
  displayName: string
  kind: "managed" | "custom"
  mode: "exclusive" | "fixed" | "switching" | "backup"
  state: "configured" | "backup"
  model: string | null
  modelCount: number | null
  selected: boolean
}

export interface ManagementProvidersResponse {
  observedAt: string
  available: boolean
  configVersion: string | number | null
  defaults: { model: string | null; reasoningEffort: string | null }
  primary: {
    id: string
    displayName: string
    kind: "official" | "managed" | "custom" | "unknown"
    mode: "official" | "exclusive" | "backup" | "unknown"
  }
  providers: ManagementProviderEntry[]
  externalAgent:
    | { status: "configured"; provider: string | null; model: string | null }
    | { status: "unavailable" | "not-configured" }
}

export interface ManagementSettingsResponse {
  revision: string
  display: SettingsSummaryResponse["gateway"]["display"]
  system: Pick<SettingsSummaryResponse["gateway"]["system"], "approvalTimeoutSeconds" | "sandbox" | "defaultWorkspace" | "defaultModel"> & {
    workspaces: Array<{ id: string; name: string; sandbox: string | null; approvalPolicy: string | null; permissions: string | null }>
  }
  automation: Pick<SettingsSummaryResponse["gateway"]["automation"], "scheduledTasksEnabled" | "threadSectionAdministratorCount">
  advanced: Pick<SettingsSummaryResponse["gateway"]["advanced"], "loggingLevel" | "pluginApiEnabled">
  network: Pick<SettingsSummaryResponse["gateway"]["network"], "configuredFields">
  metrics: {
    storage: SettingsSummaryResponse["gateway"]["metrics"]["storage"]
    sync: Pick<SettingsSummaryResponse["gateway"]["metrics"]["sync"], "enabled" | "endpointConfigured" | "deviceName" | "deviceTokenConfigured"> & { intervalSeconds: number; batchSize: number }
    view: Pick<SettingsSummaryResponse["gateway"]["metrics"]["view"], "enabled" | "endpointConfigured" | "tokenConfigured">
    center: Pick<SettingsSummaryResponse["gateway"]["metrics"]["center"], "enabled" | "host" | "port" | "tokenConfigured" | "deviceTokenConfigured">
  }
  webui: Pick<SettingsSummaryResponse["gateway"]["webui"], "host" | "port" | "tokenConfigured">
  channels: SettingsSummaryResponse["gateway"]["channels"]
}

export interface ManagementSettingInput { kind: string; value: unknown }
export interface ManagementSettingMutationResponse {
  revision: string | null
  value: unknown
  activation: { status: string; target: string; commands: readonly string[] }
  auditStatus?: "recorded" | "degraded"
  consistency?: "unknown"
  confirmationRequired?: boolean
  confirmationToken?: string
  confirmationExpiresAt?: number
}

export interface CodexUserSettingsResponse {
  version: string
  provider: string
  defaultsEditable: boolean
  models: Array<{
    model: string
    displayName: string
    reasoningEfforts: Array<{ effort: string; description: string }>
    defaultReasoningEffort: string
    isDefault: boolean
  }>
  defaults: {
    model: string | null
    reasoningEffort: string | null
    fastEnabled: boolean
    webSearch: "live" | "indexed" | "cached" | "disabled" | null
    updatePlanEnabled: boolean
    autoRecapEnabled: boolean
    reasoningSummary?: "auto" | "concise" | "detailed" | "none" | null
    planModeReasoningEffort?: string | null
    verbosity?: "low" | "medium" | "high" | null
    personality?: "none" | "friendly" | "pragmatic" | null
    checkForUpdateOnStartup?: boolean | null
    historyPersistence?: "save-all" | "none" | null
  }
  permissions: {
    editable: boolean
    defaultPermissions: string | null
    sandboxMode: "read-only" | "workspace-write" | null
    approvalPolicy: "on-request" | "never" | null
    networkAccess: boolean | null
  }
}

export interface CodexUserSettingInput { kind: string; [key: string]: unknown }

export interface ManagementTask {
  id: string
  operation: "service" | "metrics" | "update"
  action: string
  target: string | null
  state: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed"
  createdAt: string
  updatedAt: string
  error: string | null
  result: { output: string | null } | null
  auditStatus?: "recorded" | "degraded"
}

export type ManagementTaskInput =
  | { operation: "update"; action?: "source" }
  | { operation: "service"; action: "install" | "uninstall" }
  | { operation: "service"; action: "reload" }
  | { operation: "service"; action: "start" | "stop" | "restart"; target: "gateway" | "app-server" | "webui" | "center" | "all" }
  | { operation: "metrics"; action: "upgrade" | "sync-reset" | "cleanup" | "reset" }
  | { operation: "metrics"; action: "prune"; target: string }

export interface ManagementTaskPreview {
  operation: ManagementTaskInput["operation"]
  action: string
  target: string | null
  effects: string[]
  preconditions: string[]
  recovery: string
  activation: string | { status: string; target: string; commands: readonly string[] }
  resource?: unknown
  requiresConfirmation: true
}

export type ManagementApiProviderMutationInput =
  | {
      operation: "save"
      provider: { id: string; name: string; endpoint: string; apiKey?: string }
    }
  | { operation: "delete"; id: string }

export interface ManagementApiProvider {
  id: string
  name: string
  protocol: "responses"
  endpoint: string
  hasApiKey: boolean
}

export interface ManagementApiProviderActivation {
  status: string
  target: string
  commands: readonly string[]
}

export interface ManagementApiProviderPreview {
  operation: "create" | "update" | "delete"
  provider: {
    id: string
    name: string
    protocol?: "responses"
    endpoint?: string
    apiKeyChange?: boolean
  }
  activation: ManagementApiProviderActivation
}

export interface ManagementApiProviderPreviewResponse {
  preview: ManagementApiProviderPreview
  resourceRevision: string
  confirmationToken: string
  confirmationExpiresAt: number
}

export interface ManagementApiProviderMutationResponse {
  action: string
  provider?: ManagementApiProvider | { id: string; name: string } | string
  activation?: string
  activationResult?: ManagementApiProviderActivation
  auditStatus?: "recorded" | "degraded"
}

export interface ManagementProviderSettingsResponse {
  observedAt: string
  resourceRevision: string
  configVersion: string | number | null
  defaults: { model: string | null; reasoningEffort: string | null }
  primary: {
    id: string
    displayName: string
    kind: "official" | "managed" | "custom" | "unknown"
    mode: "official" | "exclusive" | "backup" | "unknown"
  }
  managedProviders: Array<{
    id: string
    displayName: string
    mode: "switching" | "exclusive"
    model: string
    reasoningEffort: string
    models: Array<{
      id: string
      displayName: string
      contextWindow: number
      reasoningEffort: string
      reasoningEfforts: Array<{ effort: string; description: string }>
      autoCompactLimit?: number
      autoCompactPercent?: number
    }>
  }>
  customProviders: {
    fixedCandidates: Array<{
      id: string
      displayName: string
      kind: "custom"
      state: "configured" | "backup"
      active: boolean
      supportsWebsockets?: boolean
      baseUrl: string
    }>
    switchingProviders: Array<{
      id: string
      displayName: string
      mode: "switching"
      model: string
      reasoningEffort: string | null
      supportsWebsockets?: boolean
      baseUrl: string
    }>
    backupCandidates: Array<{
      id: string
      displayName: string
      kind: "custom"
      state: "configured" | "backup"
      active: boolean
      supportsWebsockets?: boolean
      baseUrl: string
    }>
  }
  externalAgent:
    | { status: "configured"; provider: string; model: string }
    | { status: "unavailable" | "not-configured" }
}

export type ManagementProviderSettingsMutationInput =
  | { operation: "primary.switch"; providerId: string; model?: string }
  | { operation: "primary.remove"; providerId: string }
  | {
      operation: "primary.custom.save"
      provider: {
        operation: "create" | "update"
        providerId: string
        name: string
        baseUrl: string
        mode: "switching" | "exclusive"
        model: string
        supportsWebsockets: boolean
        credential: { action: "preserve" } | { action: "replace"; apiKey: string }
        confirmRemoveTopLevelBaseUrl?: boolean
      }
    }
  | {
      operation: "managed.default"
      provider: string
      model: string
      reasoningEffort: string
      autoCompactPercent: number
    }
  | { operation: "external-agent"; action: "configure"; provider: string; model?: string }
  | { operation: "external-agent"; action: "disable" }

export interface ManagementProviderSettingsPreview {
  operation: "switch" | "remove" | "create" | "update" | "managed.default" | "configure" | "disable"
  activation: string
  target?: {
    id: string
    displayName: string
    source?: string
    state?: string
    baseUrl?: string
    model?: string | null
  }
  provider?: {
    id: string
    displayName?: string
    name?: string
    baseUrl?: string
    mode?: string
    catalog?: string
    apiKeyChange?: boolean
  }
  model?: { id: string; displayName: string; contextWindow?: number }
  reasoningEffort?: string
  autoCompactPercent?: number
  autoCompactLimit?: number
  willChange?: boolean
  effects?: Record<string, boolean | string[] | string | null>
  credential?: {
    action?: "preserve" | "replace"
    storedAsPlaintext?: true
    destination?: "private-profile" | "main-config"
  }
  current?: { configured: boolean; provider: string | null; model: string | null }
  selection?: { provider: string; providerDisplayName?: string; model: string; modelDisplayName?: string }
}

export interface ManagementProviderSettingsPreviewResponse {
  preview: ManagementProviderSettingsPreview
  resourceRevision: string
  confirmationToken: string
  confirmationExpiresAt: number
}

export interface ManagementProviderSettingsMutationResponse {
  action: string
  operation?: string
  target?: ManagementProviderSettingsPreview["target"]
  provider?: ManagementProviderSettingsPreview["provider"]
  model?: ManagementProviderSettingsPreview["model"]
  reasoningEffort?: string
  autoCompactPercent?: number
  autoCompactLimit?: number
  effects?: Record<string, boolean | string[] | string | null>
  warnings?: Array<{ code: string; providerId?: string }>
  activation?: string
  auditStatus?: "recorded" | "degraded"
  current?: { configured: boolean; provider: string | null; model: string | null }
  previous?: { configured: boolean; provider: string | null; model: string | null }
  selection?: { provider: string; providerDisplayName?: string; model: string; modelDisplayName?: string }
}

export interface ManagementAccountSettingsResponse {
  observedAt: string
  resourceRevision: string
  opencodeGo: {
    configured: boolean
    defaultAccountId: string | null
    accounts: Array<{
      id: string
      displayName: string
      email?: string
      phone?: string
      mode?: "switching" | "exclusive"
      default: boolean
    }>
  }
  deepseek: {
    configured: boolean
    mode: "switching" | "exclusive" | null
    model: string | null
    restoreAvailable: boolean
  }
}

export type ManagementAccountSettingsMutationInput =
  | {
      operation: "opencode.account.configure"
      accountId: string
      contact?: string
      email?: string
      phone?: string
      mode?: "switching" | "exclusive"
      reconfigure?: boolean
      apiKey: string
      confirmExclusiveConfigChange?: boolean
    }
  | { operation: "opencode.account.default"; accountId: string }
  | { operation: "opencode.account.stop"; accountId: string }
  | { operation: "opencode.account.remove"; accountId: string; confirmHistoryLoss?: boolean }
  | {
      operation: "deepseek.configure"
      mode?: "switching" | "exclusive"
      apiKey: string
      autoCompactPercent?: number
      confirmExclusiveConfigChange?: boolean
    }
  | { operation: "deepseek.restore"; confirmRestore?: boolean }

export interface ManagementAccountSettingsPreview {
  operation: string
  activation?: string
  account?: {
    id?: string
    provider?: string
    displayName?: string
    email?: string
    phone?: string
    default?: boolean
    exists?: boolean
  }
  provider?: { id?: string; name?: string }
  mode?: string
  model?: string
  status?: string
  willChange?: boolean
  effects?: Record<string, boolean | string[] | string | null>
  confirmation?: { required?: boolean; field?: string }
}

export interface ManagementAccountSettingsPreviewResponse {
  preview: ManagementAccountSettingsPreview
  resourceRevision: string
  confirmationToken: string
  confirmationExpiresAt: number
}

export interface ManagementAccountSettingsMutationResponse {
  action: string
  operation?: string
  account?: ManagementAccountSettingsPreview["account"]
  provider?: ManagementAccountSettingsPreview["provider"]
  mode?: string
  model?: string
  status?: string
  willChange?: boolean
  effects?: ManagementAccountSettingsPreview["effects"]
  activation?: string
  warnings?: Array<{ code: string; providerId?: string }>
  auditStatus?: "recorded" | "degraded"
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
