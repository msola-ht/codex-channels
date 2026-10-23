import type { GenerationTiming } from "../runtime/request-timing.mjs"
import type { ResponsesModelDefinition } from "../runtime/model-provider-responses-catalog.mjs"
import type { CustomModelCapabilityProbeResult } from "./custom-model-capability-probe.mjs"
export type { ProviderWebSearchProbeInput as ManagementProviderWebSearchProbeInput, ProviderWebSearchProbeResult as ManagementProviderWebSearchProbeResult } from "./provider-web-search-probe.mjs"
import type { RelayModelReasoning } from "../runtime/chat-reasoning.mjs";
export type { RelayModelReasoning } from "../runtime/chat-reasoning.mjs";
import type { RelayReasoningProbeInput, RelayReasoningProbeResult } from "./relay-reasoning-probe.mjs";
export type { RelayReasoningProbeInput, RelayReasoningProbeResult, RelayReasoningProbeEvent } from "./relay-reasoning-probe.mjs";

export type ManagementCustomModelProbeResult = CustomModelCapabilityProbeResult & (
  | { capability: "webSearch"; connectionToken?: never }
  | { capability: "applyPatch" | "toolSearch"; connectionToken: string }
)
export interface ManagementCustomModelProbeInput {
  providerId?: string
  baseUrl: string
  model: string
  upstreamWireApi: "responses" | "chat_completions"
  capability: "applyPatch" | "toolSearch" | "webSearch"
  reasoningEffort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
  credential: { action: "preserve" } | { action: "replace"; apiKey: string }
}
export type RangeName =
  | "today" | "yesterday" | "24h" | "7d" | "30d" | "90d" | "all"

export interface Range<Name extends string = RangeName> {
  name: Name
  startAtMs: number
  endAtMs: number
}

export interface MetricsQuery {
  requestPurpose?: "unmarked" | "autoApprovalReview"
  source?: "owned" | "relay"
  callerId?: string
  range?: RangeName
  from?: string
  to?: string
  threadId?: string
  turnId?: string
  provider?: string[]
  model?: string
  operation?: "response" | "compact"
  status?: "completed" | "failed" | "incomplete" | "unknown"
  filter?: string
  offset?: number
  limit?: number
  sort?: string
  direction?: "asc" | "desc"
}

export interface MetricsPageSummary {
  range: Range<string>
  total: number
  nextOffset: number | null
  aggregate: Aggregate | null
}

export type MetricsRangeQuery = Pick<MetricsQuery, "range" | "from" | "to">

export interface MetricsProvidersResponse {
  providers: string[]
}

export interface ServerTimeResponse {
  timeZone: string
  nowMs: number
}

export type ServiceLogTarget = "gateway" | "app-server" | "webui" | "relay"
export interface ServiceLogsResponse {
  target: ServiceLogTarget
  observedAt: string
  streams: { source: "journal" | "stdout" | "stderr"; lines: string[]; truncated: boolean; missing: boolean }[]
}

export interface RequestOutcomeCounts {
  completed: number
  interrupted: number
  failed: number
  incomplete: number
}

export interface RequestInterruptionSummary {
  followedByCompletion: number
  noObservedCompletion: number
  usageUnobserved: number
}

export interface CompactSummary {
  usageCoverage: UsageCoverage
  model: string | null
  hasMixedModels: boolean
  requestCount: number
  unsuccessfulRequestCount: number
  requestOutcomes: RequestOutcomeCounts
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
}

export interface CacheUsage {
  cachedInputTokens: number | null
  inputTokens: number
  missingRequestCount: number
}

export interface UsageCoverage {
  inputMissingRequestCount: number
  outputMissingRequestCount: number
  reasoningMissingRequestCount: number
}

export interface ReviewUsage {
  requestCount: number
  inputTokens: number
  outputTokens: number
  usageCoverage: UsageCoverage
}

export interface Aggregate {
  usageCoverage: UsageCoverage
  reviewUsage: ReviewUsage
  cacheUsage: CacheUsage
  requestCount: number
  unsuccessfulRequestCount: number
  requestOutcomes: RequestOutcomeCounts
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
  reasoningOutputTokens: number
  compact: CompactSummary | null
}

export interface ProviderGroup {
  provider: string | null
  model: string | null
  aggregate: Aggregate
  threadCount: number
  turnCount: number
}

export interface ModelUsage extends Aggregate {
  model: string | null
  turnCount: number
  members: Array<Aggregate & {
    provider: string
    model: string | null
    turnCount: number
  }>
}

export interface ErrorGroup {
  source: "owned" | "relay"
  errorCode: string | null
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
  requestOutcomes: RequestOutcomeCounts
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
    inputTokensPerPercent: number
    outputTokensPerPercent: number
    totalTokensPerPercent: number
  } | null
}

export interface OverviewResponse {
  range: Range<string>
  generatedAt: string
  global: Aggregate | null
  threadCount: number
  turnCount: number
  providers: ProviderGroup[]
  models: ModelUsage[]
  errors: ErrorsReport
  weeklyQuota: WeeklyQuota | null
  trend: UsageTrendResponse
  heatmap: DailyUsageResponse
}

export interface DailyUsageRow {
  usageCoverage: UsageCoverage
  reviewUsage: ReviewUsage
  day: string
  cacheUsage: CacheUsage
  requestCount: number
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
}

export interface DailyUsageResponse {
  range: Range<string>
  generatedAt: string
  daily: DailyUsageRow[]
}

export interface HourlyUsageRow extends Omit<DailyUsageRow, "day"> {
  hour: string
}

export type UsageTrendResponse = { range: Range<string>; generatedAt: string } & (
  | { granularity: "day"; daily: DailyUsageRow[] }
  | { granularity: "hour"; hourly: HourlyUsageRow[] }
)

export interface ThreadListItem {
  usageCoverage: UsageCoverage
  requestOutcomes: RequestOutcomeCounts
  totalTokens: number
  cachedInputTokens: number | null
  subagentUsage: { requestCount: number; usageCoverage: UsageCoverage; inputTokens: number; cachedInputTokens: number | null; outputTokens: number; cacheUsage: CacheUsage }
  cacheUsage: CacheUsage
  sessionTiming: SessionExecutionTiming
  threadId: string
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  agentPath: string | null
  parentThreadId: string | null
  parentTurnId: string | null
  directSubagentCount: number
  turnCount: number
  requestCount: number
  inputTokens: number
  outputTokens: number
  compact: CompactSummary | null
  firstRequestStartedAtMs: number
  lastRecordedAtMs: number
}

export interface ThreadsResponse extends MetricsPageSummary {
  treeAggregate: Aggregate | null
  generatedAt: string
  threads: ThreadListItem[]
  turnCount: number
}

export interface SubagentListItem extends Pick<ThreadListItem,
  "provider" | "model" | "reasoningEffort" | "turnCount" | "requestCount" | "requestOutcomes" | "inputTokens" | "outputTokens" | "cacheUsage" | "usageCoverage"
> {
  threadId: string
  parentThreadId: string
  parentTurnId: string | null
  agentPath: string
  recordedAtMs: number
  directSubagentCount: number
  turnIds: string[] | null
  turnIdsTruncated: boolean
  executionTiming: {
    durationMs: number | null
    observedTurnCount: number
    missingDurationTurnCount: number
    historyComplete: boolean
  }
  liveState: { threadId: string; status: "active" | "idle" | "systemError" | "notLoaded"; observedAtMs: number }
    | { threadId: string; status: "unknown"; reason: "gateway_unavailable" | "provider_unavailable" | "thread_unavailable" | "timeout" | "invalid_response" }
  firstRequestStartedAtMs: number | null
  lastRecordedAtMs: number | null
}

export interface SubagentsResponse {
  generatedAt: string
  subagents: SubagentListItem[]
  summary: Pick<SubagentListItem, "requestCount" | "requestOutcomes" | "turnCount" | "inputTokens" | "outputTokens" | "cacheUsage" | "usageCoverage">
  modelUsage: Array<Pick<ModelUsage, "model" | "requestCount" | "turnCount" | "inputTokens" | "outputTokens" | "cacheUsage" | "usageCoverage">>
  total: number
  offset: number
  limit: number
  nextOffset: number | null
}

export interface ThreadSubagentsResponse extends SubagentsResponse {
  threadId: string
}

export interface TurnSummary {
  usageCoverage: UsageCoverage
  durationMs?: number | null
  provider: string | null
  model: string | null
  reasoningEffort: string | null
  turnId: string
  requestCount: number
  unsuccessfulRequestCount: number
  requestOutcomes: RequestOutcomeCounts
  interruptionSummary: RequestInterruptionSummary
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
  reasoningOutputTokens: number
  reasoningRequestCount: number
  compact: CompactSummary | null
  recordedAtMs?: number
}

export interface SessionExecutionTiming {
  knownDurationMs: number | null
  missingTurnCount: number
  historyComplete: boolean
}

export interface ThreadRunResponse {
  sessionTiming?: SessionExecutionTiming
  latestExecution?: { turnId: string; durationMs: number | null } | null
  sessionDurationMs?: number | null
  generatedAt: string
  threadId: string
  agentPath: string | null
  parentThreadId: string | null
  parentTurnId: string | null
  latestTurn: TurnSummary | null
  threadAggregate: (Omit<Aggregate, "cacheUsage" | "reviewUsage"> & { turnCount: number; interruptionSummary: RequestInterruptionSummary }) | null
}

export interface ThreadTurnsResponse extends MetricsPageSummary {
  generatedAt: string
  threadId: string
  turns: Array<TurnSummary & { directSubagentCount: number }>
  turnCount: number
  subagentTurnCount: number | null
  subagentAggregate: Aggregate | null
  treeAggregate: Aggregate | null
}

export interface RequestRecord {
  /** 是否关联已登记的子代理；false 不代表已确认是主代理。 */
  isSubagent: boolean
  requestPurpose?: "autoApprovalReview" | null
  reviewerThreadId?: string | null
  reviewerTurnId?: string | null
  upstreamProvider?: string | null
  upstreamAttemptCount?: number | null
  modelAttemptCount?: number | null
  finishReason?: string | null
  errorStage?: "http" | "stream" | null
  upstreamErrorCode?: string | null
  upstreamErrorType?: string | null
  upstreamHttpStatus?: number | null

  source?: "owned" | "relay"
  callerId?: string | null
  /** 当前配置中的用途名称；仅用于展示，不改变历史调用身份或筛选。 */
  callerDisplayName?: string
  keyId?: string | null
  credentialGeneration?: number | null
  relayRequestId?: string | null
  deliveryStatus?: "finished" | "disconnected" | "failed" | null
  totalDurationMs: number | null
  /** 本次逻辑请求实际发往模型上游的正文或 WebSocket 请求帧字节合计。 */
  requestBytes: number | null
  traffic: { label: string; session: string; interaction: number } | null
  firstTokenMs: number | null
  responseTimeMs?: number | null
  generationTiming?: GenerationTiming | null
  requestModel: string | null
  responseModel: string | null
  responseUsageAmount?: string | null
  upstreamTtftMs: number | null
  id: number
  provider: string | null
  model: string | null
  operation: "response" | "compact"
  status: string
  httpStatus: number | null
  errorType: string | null
  errorCode: string | null
  errorMessage: string | null
  transport: string
  responseFormat: string
  serviceTier: string | null
  requestServiceTier: string | null
  reasoningEffort: string | null
  userAgent: string | null
  threadId: string | null
  turnId: string | null
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  reasoningOutputTokens: number | null
  totalTokens: number | null
  cacheHitRate: number | null
  /** Local quota snapshot observation time; null when not collected. */
  quotaObservedAtMs: number | null
  recordedAtMs: number
}

export type RequestSortKey =
  | "totalDuration"
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
  | "requestBytes"

export type RequestSortDirection = "asc" | "desc"

export interface RequestsResponse {
  range: Range<string>
  generatedAt: string
  records: RequestRecord[]
  nextOffset: number | null
  /** 当前筛选条件下匹配的记录总数（未筛选时等于时间范围内全部记录数） */
  total: number
  aggregate: Aggregate | null
}

export interface ErrorsResponse {
  range: Range<string>
  generatedAt: string
  errors: ErrorsReport
  /** 按发生时间倒序的单条失败请求。 */
  records: RequestRecord[]
  nextOffset: number | null
  total: number
  aggregate: Aggregate | null
}

export interface ModelTrafficSettingsResponse {
  modelTrafficDumpEnabled: boolean
}

export interface SettingsSummaryResponse {
  observedAt: string
  revision: string
  gateway: {
    display: {
      operationUpdates: "full" | "compact" | "hidden"
      planUpdatesEnabled: boolean
      reasoningEnabled: boolean
      modelAliases: Record<string, string>
    }
    system: {
      approvalTimeoutSeconds: number
      defaultWorkspace: string | null
      defaultModel: string | null
      modelTrafficMode: "production" | "debug"
      modelTrafficDumpEnabled: boolean
      modelTrafficRetentionDays: number
    }
    automation: { scheduledTasksEnabled: boolean }
    network: { configuredFields: string[] }
    advanced: {
      loggingLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace"
    }
    webui: { enabled?: boolean; host: string; port: number; tokenConfigured: boolean }
    metrics: {
      storage: { retentionDays: number; maxRows: number }
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
  target: "gateway" | "app-server" | "webui" | "model-relay"
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

export interface UpstreamUserAgentResponse {
  observedAt: string
  configuredUserAgent: string | null
  appServerUserAgent: string | null
  effectiveUserAgent: string | null
  source: "override" | "app-server" | "unavailable"
  recentRequestUserAgent: string | null
  recentRequestAtMs: number | null
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
  official: { authenticated: boolean }
  providers: ManagementProviderEntry[]
}

export interface ManagementSettingsResponse {
  revision: string
  display: SettingsSummaryResponse["gateway"]["display"]
  system: Pick<SettingsSummaryResponse["gateway"]["system"], "approvalTimeoutSeconds" | "defaultWorkspace" | "defaultModel" | "modelTrafficMode" | "modelTrafficDumpEnabled" | "modelTrafficRetentionDays"> & {
    idleReleaseMinutes: number
    officialTuiIdentity: {
      followCliVersion: boolean
      clientIdentity: { name: string | null; title: string | null; version: string | null }
      upstreamUserAgent: string | null
      terminalIdentity: string | null
      defaults: { name: string; version: string }
    }
    workspaces: Array<{ id: string; name: string }>
  }
  automation: Pick<SettingsSummaryResponse["gateway"]["automation"], "scheduledTasksEnabled">
  advanced: Pick<SettingsSummaryResponse["gateway"]["advanced"], "loggingLevel">
  network: Pick<SettingsSummaryResponse["gateway"]["network"], "configuredFields">
  telegram: { configured: boolean; messageFormat: "html" | "rich" }
  metrics: {
    storage: SettingsSummaryResponse["gateway"]["metrics"]["storage"]
  }
  webui: Pick<SettingsSummaryResponse["gateway"]["webui"], "host" | "port" | "tokenConfigured">
  channels: SettingsSummaryResponse["gateway"]["channels"]
}

export interface ManagementSettingInput { kind: string; value: unknown; [key: string]: unknown }
export interface ManagementSettingMutationResponse {
  action?: string
  willChange?: boolean
  revision: string | null
  value: unknown
  activation: { status: string; target: string; commands: readonly string[] }
  auditStatus?: "recorded" | "degraded"
  consistency?: "confirmed" | "unknown"
  writeStatus?: "ok" | "okOverridden" | null
  targetFingerprint?: string
  warnings?: Array<{ code: string; providerId?: string }>
  confirmationRequired?: boolean
  confirmationToken?: string
  confirmationExpiresAt?: number
  generatedWebuiToken?: string
}

export type OpenAiModelCatalogEntry = import("./webui-official-model-catalog.mjs").OpenAiModelCatalogEntry

export interface OpenAiModelCatalogResponse {
  source: "codex-cache"
  revision: string
  scope: string
  fetchedAt: string
  clientVersion: string | null
  models: OpenAiModelCatalogEntry[]
}

export interface OpenAiModelContextInput {
  revision: string
  model: string
  contextWindow: number
}

export type OpenAiModelContextPreview = import("./webui-official-model-catalog.mjs").OpenAiModelContextPreview

export type OpenAiModelContextResult = import("./webui-official-model-catalog.mjs").OpenAiModelContextResult & {
  auditStatus: "recorded" | "degraded"
}

export interface OpenAiModelRefreshInput { revision: string }
export type OpenAiModelPromptsResponse = import("./webui-official-model-catalog.mjs").OpenAiModelPrompts
export type ProviderModelPromptsResponse = OpenAiModelPromptsResponse & Pick<ResponsesModelDefinition, "template" | "sampling">
export type OpenAiModelRefreshPreview = import("./webui-official-model-catalog.mjs").OpenAiModelRefreshPreview
export type OpenAiModelRefreshResult = import("./webui-official-model-catalog.mjs").OpenAiModelRefreshResult & {
  auditStatus: "recorded" | "degraded"
}

export type CodexUserSettingsResponse = import("./codex-user-settings-management.mjs").CodexUserSettingsState

export interface CodexUserSettingInput { kind: string; [key: string]: unknown }

export interface ManagementTaskResult {
  commitState: "not_started" | "unchanged" | "committed" | "not_committed" | "unknown"
  failurePhases: Array<"commit" | "vacuum" | "count" | "close" | "lock-release" | "gateway-restart">
}

export interface ManagementTask {
  id: string
  operation: "service" | "metrics" | "traffic"
  action: string
  target: string | null
  state: "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed"
  createdAt: string
  updatedAt: string
  error: string | null
  errorCode: "start_failed" | "execution_failed" | "cancellation_unconfirmed" | "process_cleanup_unconfirmed" | "result_unconfirmed" | null
  result: ManagementTaskResult | null
  auditStatus: "recorded" | "degraded" | null
}

export type ManagementTaskInput =
  | { operation: "service"; action: "install" | "uninstall" }
  | { operation: "service"; action: "reload" }
  | { operation: "service"; action: "start" | "stop" | "restart"; target: "gateway" | "app-server" | "webui" | "model-relay" | "all" }
  | { operation: "metrics"; action: "cleanup" | "reset" }
  | { operation: "metrics"; action: "prune"; target: string }
  | { operation: "traffic"; action: "cleanup" }

export interface ManagementTaskPreview {
  operation: ManagementTaskInput["operation"]
  action: string
  target: string | null
  effects: string[]
  preconditions: string[]
  recovery: "traffic_irreversible" | "metrics_restore" | "metrics_backup" | "service_check"
  activation: string | { status: string; target: string; commands: readonly string[] }
  resource?: unknown
  requiresConfirmation: true
}

export interface ManagementProviderModelCatalogsResponse {
  catalogs: ManagementProviderSettingsResponse["modelCatalogs"]
}

export interface ManagementProviderSettingsResponse {
  observedAt: string
  resourceRevision: string
  configVersion: string | number | null
  defaults: { model: string | null; reasoningEffort: string | null }
  webSearchSettings: import("./model-provider-management.mjs").ProviderWebSearchSetting[]
  modelCatalogs: Array<{
    provider: string
    source: "managed" | "custom" | "official-shared"
    revision: string
    displayName: string
    providers: string[]
    models: Array<{ id: string; displayName: string; isDefault: boolean; removalBlockedReason: import("./provider-model-management.mjs").ProviderModelRemovalBlockedReason | null; presentation: OpenAiModelCatalogEntry & { editable: false } }>
    canRemove: boolean
    unavailableReason?: string
  }>
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
      maxContextWindow: number
      reasoningEffort: string
      reasoningEfforts: Array<{ effort: string; description: string }>
      windowPercent?: number
    }>
  }>
  customProviders: {
    fixedCandidates: Array<{
      catalog?: "custom"
      models?: ResponsesModelDefinition[]
      id: string
      displayName: string
      kind: "custom"
      state: "configured" | "backup"
      active: boolean
      supportsWebsockets?: boolean
      upstreamWireApi?: "responses" | "chat_completions"
      baseUrl: string
    }>
    switchingProviders: Array<{
      catalog?: "custom"
      models?: ResponsesModelDefinition[]
      id: string
      displayName: string
      mode: "switching"
      model: string
      reasoningEffort: string | null
      supportsWebsockets?: boolean
      upstreamWireApi?: "responses" | "chat_completions"
      baseUrl: string
    }>
    backupCandidates: Array<{
      catalog?: "custom"
      models?: ResponsesModelDefinition[]
      id: string
      displayName: string
      kind: "custom"
      state: "configured" | "backup"
      active: boolean
      supportsWebsockets?: boolean
      upstreamWireApi?: "responses" | "chat_completions"
      baseUrl: string
    }>
  }
}

export type ProviderModelTemplateSource = "official" | "deepseek" | "cline"
export type ProviderModelTemplateSection = "prompts" | "capabilities" | "settings"
export type ProviderModelTemplateValue = { present: false } | { present: true; value: unknown }
export interface ProviderModelTemplateOptionsResponse {
  provider: string
  revision: string
  sourceToken: string
  expiresAt: number
  availableSections: ProviderModelTemplateSection[]
  targets: Array<{ model: string; displayName: string; template: { source: ProviderModelTemplateSource; model: string } | null }>
  templates: Array<{ source: ProviderModelTemplateSource; model: string; displayName: string }>
}
export interface ProviderModelTemplateUpdateInput {
  operation: "model.template.update"
  provider: string
  model: string
  sections: ProviderModelTemplateSection[]
  revision: string
  sourceToken: string
  template: { source: ProviderModelTemplateSource; model: string }
}

export type ManagementProviderSettingsMutationInput =
  | ({ operation: "provider.web-search" } & import("./provider-web-search-management.mjs").ProviderWebSearchChangeInput)
  | ({ operation: "model.add" } & import("./provider-model-additions.mjs").ProviderModelAdditionInput)
  | ProviderModelTemplateUpdateInput
  | { operation: "model.remove"; provider: string; model: string }
  | { operation: "model.context"; provider: string; model: string; contextWindow: number; revision: string }
  | { operation: "model.rename"; provider: string; model: string; displayName: string; revision: string }
  | { operation: "model.custom.save"; resourceRevision: string; provider: string; models: ResponsesModelDefinition[]; model: string; probeConnections?: Array<{ model: string; capability: "applyPatch" | "toolSearch"; token: string }> }
  | { operation: "primary.switch"; providerId: string; model?: string }
  | { operation: "primary.remove"; providerId: string }
  | {
      operation: "primary.custom.connection.save"
      resourceRevision: string
      provider: import("./custom-primary-provider-management.mjs").CustomProviderConnectionSaveInput
    }
  | {
      operation: "primary.custom.save"
      resourceRevision?: string
      provider: {
        operation: "create" | "update"
        providerId: string
        name: string
        baseUrl: string
        mode: "switching" | "exclusive"
        model: string
        catalog?: { kind: "custom"; models: ResponsesModelDefinition[] }
        supportsWebsockets: boolean
        upstreamWireApi?: "responses" | "chat_completions"
        credential: { action: "preserve" } | { action: "replace"; apiKey: string }
        probeConnections?: Array<{ model: string; capability: "applyPatch" | "toolSearch"; token: string }>
        confirmRemoveTopLevelBaseUrl?: boolean
      }
    }
  | {
      operation: "managed.default"
      provider: string
      model: string
      reasoningEffort: string
    }

export interface ManagementProviderSettingsStandardPreview {
  operation: "switch" | "remove" | "create" | "update" | "managed.default" | "model.remove" | "model.context" | "model.rename" | "model.custom.save"
  revision?: string
  before?: { defaultModel: string; reasoningEffort: string }
  modelDefaults?: {
    catalog: { before: string; after: string }
    selection: {
      before: { model: string | null; reasoningEffort: string | null }
      after: { model: string | null; reasoningEffort: string | null }
    }
  }
  warnings?: Array<{ code: string }>
  activation: string
  target?: {
    id: string
    displayName: string
    source?: string
    state?: string
    baseUrl?: string
    model?: string | null
  }
  provider?: string | {
    id: string
    displayName?: string
    name?: string
    model?: string
    baseUrl?: string
    mode?: string
    supportsWebsockets?: boolean
    upstreamWireApi?: "responses" | "chat_completions"
    catalog?: string
    models?: ResponsesModelDefinition[]
    apiKeyChange?: boolean
  }
  model?: { id: string; displayName: string; contextWindow?: number; maxContextWindow?: number }
  displayName?: string
  providers?: string[]
  reasoningEffort?: string
  windowPercent?: number
  contextWindow?: number
  willChange?: boolean
  effects?: Record<string, boolean | string[] | string | null>
  credential?: {
    action?: "preserve" | "replace"
    storedAsPlaintext?: true
    destination?: "private-profile" | "private-credential"
  }
  transport?: { scheme?: "http" | "https"; cleartext?: boolean }
}

export interface ProviderModelTemplateUpdatePreview extends Omit<ManagementProviderSettingsStandardPreview, "operation" | "provider" | "model"> {
  operation: "model.template.update"
  provider: string
  model: string
  source: ProviderModelTemplateSource
  sourceModel: string
  sections: ProviderModelTemplateSection[]
  changes: Array<{ field: string; before: ProviderModelTemplateValue; after: ProviderModelTemplateValue }>
  willChange: boolean
}
export type ProviderModelAdditionManagementPreview = Omit<ManagementProviderSettingsStandardPreview, "operation" | "provider" | "revision" | "activation" | "providers" | "willChange"> & import("./provider-model-additions.mjs").ProviderModelAdditionPreview & {
  operation: "model.add"
}
export interface ProviderWebSearchManagementPreview extends Omit<ManagementProviderSettingsStandardPreview, "operation" | "provider" | "before" | "effects"> {
  operation: "provider.web-search"
  provider: string
  before: { mode: import("../runtime/provider-web-search.mjs").ProviderWebSearchMode | null }
  mode: import("../runtime/provider-web-search.mjs").ProviderWebSearchMode | null
}
export type ManagementProviderSettingsPreview = ManagementProviderSettingsStandardPreview | ProviderModelTemplateUpdatePreview | ProviderModelAdditionManagementPreview | ProviderWebSearchManagementPreview

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
  providers?: string[]
  reasoningEffort?: string
  windowPercent?: number
  contextWindow?: number
  effects?: Record<string, boolean | string[] | string | null>
  warnings?: Array<{ code: string; providerId?: string }>
  configuration?: import("./primary-provider-management.mjs").PrimaryProviderRemovalResult["configuration"]
  cleanup?: import("./primary-provider-management.mjs").PrimaryProviderRemovalResult["cleanup"]
  activation?: string
  auditStatus?: "recorded" | "degraded"
}

export interface ManagementAccountSettingsResponse {
  observedAt: string
  resourceRevision: string
  opencodeGo: {
    configured: boolean
    defaultAccountId: string | null
    accounts: Array<{
      id: string
      provider: string
      displayName: string
      email?: string
      phone?: string
      mode?: "switching" | "exclusive"
      model: string | null
      default: boolean
    }>
  }
  clinePass: {
    configured: boolean
    accounts: Array<{ id: string; provider: string; default: boolean; mode: "switching" | "exclusive" | null; model: string | null }>
  }
  deepseek: {
    configured: boolean
    accounts: Array<{ id: string; provider: string; default: boolean; mode: "switching" | "exclusive" | null; model: string | null }>
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
      apiKey?: string
      confirmExclusiveConfigChange?: boolean
    }
  | { operation: "opencode.account.default"; accountId: string }
  | { operation: "opencode.account.stop"; accountId: string }
  | { operation: "opencode.account.remove"; accountId: string; confirmHistoryLoss?: boolean }
  | {
      operation: "deepseek.configure" | "clp.configure"
      accountId: string
      reconfigure?: boolean
      mode?: "switching" | "exclusive"
      apiKey?: string
      confirmExclusiveConfigChange?: boolean
    }
  | { operation: "deepseek.default" | "deepseek.remove" | "clp.default" | "clp.remove"; accountId: string }

export interface ManagementAccountSettingsPreview {
  operation: string
  revision?: string
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
  previousMode?: string
  credentialAction?: "preserve" | "replace"
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
  accounts: DeepseekAccountBalance[]
}

export interface DeepseekAccountBalance {
  provider: string
  account: string | null
  displayName: string
  default: boolean
  available: boolean
  observedAtMs: number
  balances: DeepseekBalance[]
}

export interface OpencodeGoQuotaWindow {
  windowId: string
  label: string
  usedPercent: number
  resetsAt: number | null
  status: string | null
  localTokens?: number | null
}

export interface QuotaAccountUsage {
  subscriptionRequired: boolean
  provider: string
  account: string | null
  displayName: string
  default: boolean
  available: boolean
  observedAtMs: number
  windows: OpencodeGoQuotaWindow[]
}

export interface OpencodeGoUsageResponse {
  accounts: QuotaAccountUsage[]
}

export interface CcgCreditAccountUsage {
  provider: string
  account: string | null
  displayName: string
  default: boolean
  available: boolean
  observedAtMs: number
  planId: string | null
  monthlyRemaining: string
  purchasedRemaining: string
  freeRemaining: string
  totalRemaining: string
  windows: OpencodeGoQuotaWindow[]
}

export interface CcgCreditUsageResponse {
  accounts: CcgCreditAccountUsage[]
}

export interface OpenAiAccountCredits {
  credentialRefreshedAt?: number | null
  observedAtMs: number
  remaining: string | null
  unlimited: boolean
  resetCreditsAvailable: string | null
  expirations: Array<{ expiresAt: number | null; count: number }> | null
  undisclosedCount: string | null
}

export interface OfficialAccountSnapshot {
  credentialRefreshedAt?: number | null
  provider: string
  accountId: string | null
  displayName: string
  default: boolean
  observedAtMs: number
  available: boolean
  usage: unknown
  limits: unknown
}

export interface OfficialAccountSnapshotsResponse {
  observedAtMs: number
  snapshots: OfficialAccountSnapshot[]
  warnings: Array<{
    source: "openai" | "deepseek" | "opencode-go" | "ccg" | "clp"
    code: "registry_unavailable"
    message: string
  }>
}

export interface OfficialAccountSourcesResponse {
  accounts: Array<Pick<OfficialAccountSnapshot, "provider" | "accountId" | "displayName" | "default">>
  warnings: OfficialAccountSnapshotsResponse["warnings"]
}

export interface TrafficLabel {
  label: string
  sessions: number
  latestAtMs: number
}

export interface TrafficExchangeSummary {
  requestPurpose?: "autoApprovalReview" | null
  reviewerThreadId?: string | null
  reviewerTurnId?: string | null
  /** 已保存请求正文中的思考等级；缺失时不推断默认值。 */
  reasoningEffort?: string
  /** 从已记录 User-Agent 识别的客户端自报名称，并非已验证身份。 */
  clientName?: string
  /** 已记录请求接口使用的协议，不代表提供商的全部能力。 */
  protocol?: "chat" | "responses"
  id: number
  label: string
  session: string
  startedAtMs: number
  account?: string
  /** 请求头记录可能已被轮转清理，缺失证据时省略。 */
  transport?: "http" | "websocket"
  method?: string
  path?: string
  url?: string
  threadId?: string | null
  turnId?: string | null
  requestKind?: string
  category: "models" | "prewarm" | "model"
  status?: number
  state: "completed" | "failed" | "incomplete" | "pending"
  durationMs?: number
  /** 与调用详情同源的响应索引首 Token 延迟；缺失表示未记录或不适用。 */
  firstTokenMs?: number
  responseTimeMs?: number
  generationTiming?: GenerationTiming
  outputTokens?: number | null
  hasError: boolean
  requestModel?: string
  responseModels: string[]
  /** Chat 上游诊断记录的实际上游提供商；缺失表示没有诊断或不适用。 */
  upstreamProvider?: string
}

interface TrafficListCatalog {
  directory: string
  enabled: boolean
  retentionDays: number
  label: string | null
  labels: TrafficLabel[]
  session: string | null
  sessions: Array<{ session: string; createdAtMs: number }>
  generatedAt: string
}

export type TrafficListResponse = TrafficListCatalog & ({
  indexStatus: "ready"
  indexPending: boolean
  exchanges: TrafficExchangeSummary[]
  total: number
  nextOffset: number | null
} | {
  indexStatus: "building" | "unavailable"
  errorCode: "traffic_index_building" | "traffic_index_limit" | "traffic_index_timeout"
  exchanges: []
  total: null
  nextOffset: null
})

export type TrafficHeaderValue = string | string[]

export interface TrafficDebugStage {
  headers: Record<string, TrafficHeaderValue>
  headersTruncated: boolean
  body: string
  bodyTruncated: boolean
  status?: number
  state?: "finished" | "disconnected" | "failed" | "not_started"
}

export interface TrafficExchangeDetail {
  /** False when optional trace aggregation could not be completed within its budget. */
  diagnosticsComplete: boolean
  continuation?: {
    scope: "same_writer_thread_turn"
    complete: boolean
    next: { id: number; startedAtMs: number; gapMs: number; state: "completed" | "failed" | "incomplete" | "pending"; agentMessageObserved: boolean } | null
  }
  requestPurpose?: "autoApprovalReview" | null
  reviewerThreadId?: string | null
  reviewerTurnId?: string | null
  debug?: { inbound: TrafficDebugStage; delivered: TrafficDebugStage | null; transformations: Array<"headers_filtered" | "headers_overridden" | "stream_defaulted" | "store_defaulted" | "provider_routing_pinned" | "json_unwrapped"> }

  chatDiagnostics?: { fields: Record<string, string | number | boolean>; truncated: boolean }
  modelEvidence: {
    serverModels: Array<{ source: string; model: string }>
    safetyModels: Array<{ source: string; model: string }>
    turnStateLengths: Array<{ source: string; characters: number }>
    truncated: boolean
  }
  clientName?: string
  /** 已记录请求接口使用的协议，不代表提供商的全部能力。 */
  protocol?: "chat" | "responses"
  parameterComparison: Array<{ field: string; request: string | null; response: string | null }>
  id: number
  startedAtMs: number
  account?: string
  transport: "http" | "websocket"
  threadId?: string | null
  turnId?: string | null
  requestKind?: string
  category: "models" | "prewarm" | "model"
  requestModel?: string
  responseModels: string[]
  /** 与调用列表同源的 Chat 上游提供商；详情同时保留完整诊断字段。 */
  upstreamProvider?: string
  state: "completed" | "failed" | "incomplete" | "pending"
  url?: string
  request: {
    method?: string
    path?: string
    url?: string
    headers: Record<string, TrafficHeaderValue>
    headersTruncated?: boolean
    body: string
    bodyTruncated: boolean
    bytes?: number
    storedBytes?: number
    parameters: {
      reasoningEffort?: string
      serviceTier?: string
      previousResponseId?: string
      generate?: boolean
    }
    content: {
      instructions: string | null
      input: Array<{
        type: string; role?: string; name?: string; callId?: string; text: string; omittedItems?: number
      }> | null
      tools: Array<{ type: string; name?: string; definition: string }> | null
    }
  }
  response: {
    capture?: "redacted_upstream_chat" | "redacted_upstream_responses"
    deliveryStatus?: "finished" | "disconnected" | "failed"
    state: "completed" | "failed" | "incomplete"
    status: number | null
    headers: Record<string, TrafficHeaderValue>
    headersTruncated?: boolean
    body: string
    bodyTruncated: boolean
    bytes?: number
    durationMs?: number
    callTiming: {
      totalMs: number
    } | null
    eventType?: string
    errorScope?: string
    websocketClose?: { peer: "client"; code: number; atMs: number }
    error?: string
    storedBytes?: number
    responseId?: string
    serviceTier?: string
    usage: {
      inputTokens?: number
      cachedTokens?: number
      outputTokens?: number
      reasoningTokens?: number
      totalTokens?: number
    } | null
    failure?: string
    /** Stable stage identifier; localized by each presentation surface. */
    failureStage?: string
    output: Array<{ type: string; name?: string; callId?: string; phase?: string; text: string }>
    outputTruncated: boolean
    outputSource: "terminal" | "trace"
    firstTokenMs?: number
    responseTimeMs?: number
    generationTiming?: GenerationTiming
    outputTokens?: number | null
  } | null
  tracePage: {
    offset: number
    /** null means that a complete event-index snapshot is not yet available. */
    total: number | null
    complete: boolean
    previousOffset: number | null
    nextOffset: number | null
  }
  trace: Array<{ atMs: number; kind: string; text: string; truncated: boolean }>
}

export interface TrafficDetailResponse {
  indexPending: boolean
  directory: string
  enabled: boolean
  retentionDays: number
  label: string
  session: string
  generatedAt: string
  exchange: TrafficExchangeDetail
}

export interface TrafficTraceResponse extends Omit<TrafficDetailResponse, "exchange"> {
  exchange: Pick<TrafficExchangeDetail, "id" | "trace" | "tracePage">
}

export type RelayReasoning = "passthrough" | "off";
export interface RelayManagedCaller {
  caller_id: string; display_name?: string; key_id: string; credential_generation: number; enabled: boolean;
  models: string[]; reasoning: RelayReasoning; model_reasoning?: Record<string, RelayModelReasoning>;
}
export interface RelayManagementSnapshot {
  revision: string; enabled: boolean; maxConcurrency: number; callers: RelayManagedCaller[];
  usage: { observedAtMs: number; startAtMs: number; callers: Array<{
    callerId: string; keyId: string; lastRequestAtMs: number | null; requestCount: number; unsuccessfulRequestCount: number;
  }> } | null;
  runtime?: { state: "running"; listening: boolean; configurationValid: boolean; active: number; waiting: number; uploading: number;
    oldestWaitMs: number; queueTimeouts: number;
    capture: { enabled: boolean; state: "initializing" | "ready" | "failed" | "closed"; active: number; skippedCapacity: number };
    metrics: { accepted: number; unconfirmed: number; rejected: number; localDropped: number } }
    | { state: "stopped" | "unknown" };
  providers: Array<{ id: string; available: boolean; protocols?: Array<"chat" | "responses">; reason?: string; models: Array<{ id: string; relayId: string; reasoningOff: boolean; inputModalities: Array<"text" | "image" | "audio" | "video" | "pdf"> }> }>;
}
export type RelayManagementInput =
  | { command: "issue"; name?: string; caller: string; key: string; models: string[]; reasoning?: RelayReasoning; modelReasoning?: Record<string, RelayModelReasoning> }
  | { command: "edit"; name?: string; models?: string[]; caller: string; reasoning?: RelayReasoning; modelReasoning?: Record<string, RelayModelReasoning> }
  | { command: "rotate" | "disable" | "delete"; caller: string };
export interface RelayManagementMutation { revision: string; input: RelayManagementInput }
export interface RelayManagementPreview { command: RelayManagementInput["command"]; caller: string; callers: RelayManagedCaller[] }
export interface RelayManagementResult {
  cleanupStatus?: "failed";
  activation: "saved_and_applied" | "saved_not_running" | "saved_unconfirmed";
  key?: string; auditStatus: "recorded" | "failed";
}

export type RelayReasoningProbeProtocol = RelayReasoningProbeInput["protocol"];
export type RelayReasoningProbeRow = RelayReasoningProbeResult["rows"][number];
export type RelayReasoningProbeMode = RelayReasoningProbeRow["mode"];

/** Ephemeral authenticated model requests; not a persisted request history. */
export type RelayQueueSnapshot = { state: "stopped" | "unknown" } | {
  state: "running";
  configurationValid: boolean;
  enabled: boolean;
  listening: boolean;
  requests: Array<{
    requestId: string;
    callerId: string;
    displayName: string | null;
    provider: string | null;
    model: string | null;
    /** 已验证入站请求的思考等级；尚未解析或无可展示值时为 null。 */
    reasoningEffort: string | null;
    protocol: "chat" | "responses";
    phase: "input" | "queue" | "prepare" | "upstream" | "delivery";
    elapsedMs: number;
  }>;
};
/** HTTP contract kept independent of generated dist declarations for clean WebUI builds. */
export interface DeliveryQueueEntry {
  id: string
  revision: string
  sequence: number
  account: string
  conversation: string
  state: "pending" | "sending" | "uncertain" | "blocked"
  createdAt: number
  attempt: number
  bytes: number
  confirmed: number
  checkpoints: number
}
export interface DeliveryQueueSnapshot {
  state: "available" | "missing"
  observedAt: number
  summary: { records: number; bytes: number; pending: number; sending: number; uncertain: number; blocked: number } | null
  records: DeliveryQueueEntry[]
  nextCursor: number | null
}
export interface DeliveryRetryInput { id: string; revision: string }
export interface DeliveryRetryResult { result: "pending"; auditStatus: "recorded" | "failed"; cleanupStatus: "closed" | "unconfirmed" }

export interface DeliveryBatchInput { action: "retry" | "ignore"; entries: DeliveryRetryInput[] }
export interface DeliveryBatchPreview { action: "retry" | "ignore"; count: number }
export interface DeliveryBatchResult { result: "pending" | "ignored"; count: number; auditStatus: "recorded" | "failed"; cleanupStatus: "closed" | "unconfirmed" }

export interface DeliveryContent { type: string; text: string | null; truncated: boolean; threadId: string | null; turnId: string | null; status: string | null; imageFormat: "png" | "jpeg" | null }

export interface DeliveryContentsResponse { records: Array<DeliveryRetryInput & { content: DeliveryContent | null }> }
export interface QueueChangeEvent { type: "changed" | "heartbeat" | "unavailable" }

export interface ResetCreditChoice {
  id: string
  title: string | null
  description: string | null
  expiresAt: number | null
}
export interface ResetCreditSnapshot {
  accountId: string
  availableCount: string
  credits: ResetCreditChoice[]
}
export interface ResetCreditPreview {
  attemptId: string
  accountId: string
  credit: ResetCreditChoice
  expiresAt: number
}
export interface ResetCreditResult {
  outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed"
  refreshed: boolean
  auditRecorded: boolean
}
