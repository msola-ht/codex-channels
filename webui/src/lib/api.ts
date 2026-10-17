import type { ResetCreditSnapshot, ResetCreditPreview, ResetCreditResult } from "./types"
import type {
  ManagementProviderWebSearchProbeInput, ManagementProviderWebSearchProbeResult,
  ManagementCustomModelProbeInput, ManagementCustomModelProbeResult,
  ServiceLogTarget, ServiceLogsResponse,
  QueueChangeEvent,
  DeliveryContentsResponse, DeliveryContent, DeliveryBatchInput, DeliveryBatchPreview, DeliveryBatchResult, DeliveryQueueEntry, DeliveryQueueSnapshot, DeliveryRetryInput, DeliveryRetryResult,
  RelayQueueSnapshot, RelayManagementSnapshot, RelayManagementMutation, RelayManagementPreview, RelayManagementResult,
  RelayReasoningProbeInput, RelayReasoningProbeResult, RelayReasoningProbeEvent,
  ServerTimeResponse,
  ModelDisplaySettingsResponse,
  ErrorsResponse,
  OfficialAccountSnapshotsResponse,
  OfficialAccountSourcesResponse,
  OverviewResponse,
  MetricsRangeQuery,
  MetricsQuery,
  MetricsProvidersResponse,
  RequestsResponse,
  SettingsSummaryResponse,
  ModelTrafficSettingsResponse,
  ManagementSettingsResponse,
  ManagementServicesResponse,
  ManagementProvidersResponse,
  OpenAiModelCatalogResponse,
  OpenAiModelPromptsResponse,
  ProviderModelPromptsResponse,
  ProviderModelTemplateOptionsResponse,
  CustomModelDraftTemplatesResponse,
  OpenAiModelContextInput,
  OpenAiModelContextPreview,
  OpenAiModelContextResult,
  OpenAiModelRefreshInput,
  OpenAiModelRefreshPreview,
  OpenAiModelRefreshResult,
  UpstreamUserAgentResponse,
  ManagementSettingInput,
  ManagementSettingMutationResponse,
  CodexUserSettingsResponse,
  CodexUserSettingInput,
  ManagementTask,
  ManagementTaskInput,
  ManagementTaskPreview,
  ManagementProviderSettingsResponse,
  ManagementProviderSettingsMutationInput,
  ManagementProviderSettingsPreviewResponse,
  ManagementProviderSettingsMutationResponse,
  ManagementAccountSettingsResponse,
  ManagementAccountSettingsMutationInput,
  ManagementAccountSettingsPreviewResponse,
  ManagementAccountSettingsMutationResponse,
  ThreadRunResponse,
  ThreadSubagentsResponse,
  SubagentsResponse,
  ThreadsResponse,
  ThreadTurnsResponse,
  TrafficDetailResponse,
  TrafficTraceResponse,
  TrafficListResponse,
} from "@/lib/types"
import { getToken } from "@/lib/token-storage"
import { metricsQueryParams } from "@/lib/metrics-query"

export { getToken, setToken } from "@/lib/token-storage"

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message)
    this.name = "ApiClientError"
    this.status = status
    this.code = code
  }
}

export const API_PREFIX = "/api/v1"
export const getServiceLogs = (target: ServiceLogTarget, lines: number, signal?: AbortSignal) =>
  getJson<ServiceLogsResponse>(`${API_PREFIX}/logs?${new URLSearchParams({ target, lines: String(lines) })}`, signal)
let unauthorizedHandler: (() => void) | null = null

export const watchDeliveryQueue = (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchQueue("delivery/events", signal, receive)
export const watchRelayQueue = (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchQueue("relay/queue/events", signal, receive)
export const watchManagementTasks = (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchQueue("tasks/events", signal, receive)
export const watchRequestMetrics = (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchQueue("metrics/events", signal, receive)
export const watchAccountSnapshots = (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchQueue("accounts/events", signal, receive)

export function watchTraffic(query: { label?: string; session?: string; detail?: boolean }, signal: AbortSignal, receive: (event: QueueChangeEvent) => void) {
  const params = new URLSearchParams()
  if (query.label !== undefined) params.set("label", query.label)
  if (query.session !== undefined) params.set("session", query.session)
  if (query.detail) params.set("detail", "1")
  return watchQueue(`traffic/events?${params}`, signal, receive)
}

/** Fetch-based SSE keeps credentials in the Authorization header, never in the URL. */
async function watchQueue(path: string, signal: AbortSignal, receive: (event: QueueChangeEvent) => void): Promise<void> {
  const controller = new AbortController()
  let idle = setTimeout(() => controller.abort(), 35_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const headers = new Headers({ accept: "text/event-stream" })
    const token = getToken()
    if (token !== null) headers.set("authorization", `Bearer ${token}`)
    const response = await fetch(`${API_PREFIX}/${path === "metrics/events" || path === "accounts/events" || path.startsWith("traffic/events?") ? path : `management/${path}`}`, { headers, cache: "no-store", signal: AbortSignal.any([signal, controller.signal]) })
    if (response.status === 401) unauthorizedHandler?.()
    if (!response.ok) throw new ApiClientError("Queue notifications unavailable", response.status, path.startsWith("accounts/") ? "account_notifications_unavailable" : path.startsWith("metrics/") ? "metrics_notifications_unavailable" : path.startsWith("tasks/") ? "task_notifications_unavailable" : path.startsWith("relay/") ? "relay_unavailable" : "delivery_unavailable")
    if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("Invalid queue stream")
    reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) throw new Error("Queue stream disconnected")
      clearTimeout(idle)
      idle = setTimeout(() => controller.abort(), 35_000)
      buffer += decoder.decode(value, { stream: true })
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        if (end > 4096) throw new Error("Queue stream frame too large")
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (!frame.startsWith("data: ")) throw new Error("Invalid queue event")
        const event: unknown = JSON.parse(frame.slice(6))
        if (!event || typeof event !== "object" || !("type" in event) || Object.keys(event).length !== 1 || !["changed", "heartbeat", "unavailable"].includes(String(event.type))) throw new Error("Invalid queue event")
        if (event.type === "unavailable") throw new Error("Queue notifications unavailable")
        receive(event as QueueChangeEvent)
      }
      // A network read may contain many valid frames; bound each frame and the unfinished tail.
      const unfinishedLength = buffer.endsWith("\n") ? buffer.length - 1 : buffer.length
      if (unfinishedLength > 4096) throw new Error("Queue stream frame too large")
    }
  } finally {
    clearTimeout(idle)
    controller.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null
  }
}

async function requestResponse(path: string, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = 30_000): Promise<Response> {
  const token = getToken()
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const effectiveSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal])
  const headers = new Headers(init.headers)
  if (!headers.has("accept")) headers.set("accept", "application/json")
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  if (token !== null) headers.set("authorization", `Bearer ${token}`)
  const response = await fetch(path, {
    ...init,
    headers,
    signal: effectiveSignal,
  })
  if (response.status === 401) {
    unauthorizedHandler?.()
  }
  if (!response.ok) {
    let code = "http_error"
    let message = `请求失败：HTTP ${response.status}`
    try {
      const body = await response.json() as {
        error?: { code?: string; message?: string }
      }
      code = body.error?.code ?? code
      message = body.error?.message ?? message
    } catch {
      // 保留 HTTP 状态默认错误信息
    }
    throw new ApiClientError(message, response.status, code)
  }
  return response
}

async function requestJson<T>(path: string, init: RequestInit = {}, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  const response = await requestResponse(path, init, signal, timeoutMs)
  return await response.json() as T
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, {}, signal)
}

export function fetchServerTime(signal?: AbortSignal): Promise<ServerTimeResponse> {
  return getJson<ServerTimeResponse>(`${API_PREFIX}/time`, signal)
}

export function fetchModelDisplaySettings(signal?: AbortSignal): Promise<ModelDisplaySettingsResponse> {
  return getJson<ModelDisplaySettingsResponse>(`${API_PREFIX}/settings/model-display`, signal)
}

export function fetchManagementSettings(signal?: AbortSignal): Promise<ManagementSettingsResponse> {
  return getJson<ManagementSettingsResponse>(`${API_PREFIX}/management/settings`, signal)
}

export function previewManagementSetting(
  revision: string,
  setting: ManagementSettingInput,
  signal?: AbortSignal,
): Promise<ManagementSettingMutationResponse> {
  return requestJson<ManagementSettingMutationResponse>(`${API_PREFIX}/management/settings/preview`, {
    method: "POST", body: JSON.stringify({ revision, setting }),
  }, signal)
}

export function updateManagementSetting(
  revision: string,
  setting: ManagementSettingInput,
  confirmationToken?: string,
  signal?: AbortSignal,
): Promise<ManagementSettingMutationResponse> {
  return requestJson<ManagementSettingMutationResponse>(`${API_PREFIX}/management/settings`, {
    method: "PATCH", body: JSON.stringify({ revision, setting, ...(confirmationToken === undefined ? {} : { confirmationToken }) }),
  }, signal)
}

export function fetchOverview(
  query: MetricsRangeQuery,
  signal?: AbortSignal,
): Promise<OverviewResponse> {
  return getJson<OverviewResponse>(
    `${API_PREFIX}/overview?${metricsQueryParams(query)}`,
    signal,
  )
}

export function fetchMetricsProviders(signal?: AbortSignal): Promise<MetricsProvidersResponse> {
  return getJson<MetricsProvidersResponse>(`${API_PREFIX}/providers`, signal)
}

export function fetchThreads(
  query: MetricsQuery,
  signal?: AbortSignal,
): Promise<ThreadsResponse> {
  return getJson<ThreadsResponse>(`${API_PREFIX}/threads?${metricsQueryParams(query)}`, signal)
}

export function fetchThreadRun(
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadRunResponse> {
  return getJson<ThreadRunResponse>(
    `${API_PREFIX}/threads/${encodeURIComponent(threadId)}/run`,
    signal,
  )
}

export function fetchThreadSubagents(
  threadId: string,
  page: { offset: number; limit: number; sortKey?: "time" | "last"; sortDirection?: "asc" | "desc"; parentTurnId?: string },
  signal?: AbortSignal,
): Promise<ThreadSubagentsResponse> {
  const params = new URLSearchParams({ offset: String(page.offset), limit: String(page.limit) })
  if (page.sortKey !== undefined) params.set("sortKey", page.sortKey)
  if (page.sortDirection !== undefined) params.set("sortDirection", page.sortDirection)
  if (page.parentTurnId !== undefined) params.set("parentTurnId", page.parentTurnId)
  return getJson<ThreadSubagentsResponse>(`${API_PREFIX}/threads/${encodeURIComponent(threadId)}/subagents?${params}`, signal)
}

export function fetchSubagents(
  page: { offset: number; limit: number; sortKey?: "time" | "last"; sortDirection?: "asc" | "desc" },
  signal?: AbortSignal,
): Promise<SubagentsResponse> {
  const params = new URLSearchParams({ offset: String(page.offset), limit: String(page.limit) })
  if (page.sortKey !== undefined) params.set("sortKey", page.sortKey)
  if (page.sortDirection !== undefined) params.set("sortDirection", page.sortDirection)
  return getJson<SubagentsResponse>(`${API_PREFIX}/subagents?${params}`, signal)
}

export function fetchThreadTurns(
  threadId: string,
  query: MetricsQuery,
  signal?: AbortSignal,
): Promise<ThreadTurnsResponse> {
  return getJson<ThreadTurnsResponse>(
    `${API_PREFIX}/threads/${encodeURIComponent(threadId)}/turns?${metricsQueryParams(query)}`,
    signal,
  )
}

export function fetchRequests(
  query: MetricsQuery,
  signal?: AbortSignal,
): Promise<RequestsResponse> {
  return getJson<RequestsResponse>(`${API_PREFIX}/requests?${metricsQueryParams(query)}`, signal)
}

export async function fetchMetricsExport(query: MetricsQuery, signal?: AbortSignal): Promise<Blob> {
  const mediaType = "application/vnd.codexc.metrics-export.v1"
  const response = await requestResponse(`${API_PREFIX}/requests/export?${metricsQueryParams(query)}`, { headers: { accept: mediaType } }, signal, 150_000)
  const invalid = () => new ApiClientError("指标导出内容不完整", 502, "metrics_export_unavailable")
  if (response.headers.get("content-type") !== mediaType || response.body === null) {
    await response.body?.cancel().catch(() => {})
    throw invalid()
  }
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let pending = new Uint8Array(0)
  let offset = 0
  let bytes = 0
  let frames = 0
  let terminal: { code: string | null } | null = null
  // Read only a bounded header/payload at a time, including across network reads.
  const read = async (length: number): Promise<Uint8Array<ArrayBuffer> | null> => {
    const value = new Uint8Array(length)
    let filled = 0
    while (filled < length) {
      if (offset === pending.byteLength) {
        const next = await reader.read()
        if (next.done) {
          if (filled !== 0) throw invalid()
          return null
        }
        pending = next.value
        offset = 0
      }
      const count = Math.min(length - filled, pending.byteLength - offset)
      value.set(pending.subarray(offset, offset + count), filled)
      filled += count
      offset += count
    }
    return value
  }
  try {
    for (;;) {
      const header = await read(5)
      if (header === null) break
      if (terminal !== null) throw invalid()
      const kind = header[0]
      const length = new DataView(header.buffer).getUint32(1)
      if (kind === 1) {
        if (length === 0 || length > 64 * 1024 || ++frames > 1024) throw invalid()
        bytes += length
        if (bytes > 64 * 1024 * 1024) throw new ApiClientError("指标导出超出容量", 503, "metrics_export_capacity")
        const payload = await read(length)
        if (payload === null) throw invalid()
        chunks.push(payload.buffer)
      } else if (kind === 2 && length === 0) {
        terminal = { code: null }
      } else if (kind === 3 && length > 0 && length <= 64) {
        const payload = await read(length)
        if (payload === null) throw invalid()
        let code: string
        try { code = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload) }
        catch { throw invalid() }
        if (!["metrics_export_capacity", "metrics_export_busy", "metrics_export_timeout", "metrics_export_unavailable", "metrics_export_cancelled", "metrics_database_unavailable", "metrics_database_incompatible"].includes(code)) throw invalid()
        terminal = { code }
      } else throw invalid()
    }
    if (terminal === null || (terminal.code === null && frames === 0)) throw invalid()
    if (terminal.code !== null) throw new ApiClientError("指标导出失败", 503, terminal.code)
    return new Blob(chunks, { type: "application/json" })
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }
}

export function fetchErrors(
  query: MetricsQuery,
  signal?: AbortSignal,
): Promise<ErrorsResponse> {
  return getJson<ErrorsResponse>(
    `${API_PREFIX}/errors?${metricsQueryParams(query)}`,
    signal,
  )
}

export function fetchSettingsSummary(signal?: AbortSignal): Promise<SettingsSummaryResponse> {
  return getJson<SettingsSummaryResponse>(`${API_PREFIX}/settings/summary`, signal)
}

export function fetchModelTrafficSettings(signal?: AbortSignal): Promise<ModelTrafficSettingsResponse> {
  return getJson<ModelTrafficSettingsResponse>(`${API_PREFIX}/settings/traffic`, signal)
}

export function fetchManagementServices(signal?: AbortSignal): Promise<ManagementServicesResponse> {
  return getJson<ManagementServicesResponse>(`${API_PREFIX}/management/services`, signal)
}

export function fetchUpstreamUserAgent(signal?: AbortSignal): Promise<UpstreamUserAgentResponse> {
  return getJson<UpstreamUserAgentResponse>(`${API_PREFIX}/management/upstream-user-agent`, signal)
}

export function fetchManagementProviders(signal?: AbortSignal): Promise<ManagementProvidersResponse> {
  return getJson<ManagementProvidersResponse>(`${API_PREFIX}/management/providers`, signal)
}

export function fetchOpenAiModelCatalog(signal?: AbortSignal): Promise<OpenAiModelCatalogResponse> {
  return getJson<OpenAiModelCatalogResponse>(`${API_PREFIX}/management/models/official`, signal)
}

export function fetchOpenAiModelPrompts(model: string, revision: string, signal?: AbortSignal): Promise<OpenAiModelPromptsResponse> {
  return getJson(`${API_PREFIX}/management/models/official/prompts?${new URLSearchParams({ model, revision })}`, signal)
}

export function fetchProviderModelPrompts(provider: string, model: string, revision: string, signal?: AbortSignal): Promise<ProviderModelPromptsResponse> {
  return getJson(`${API_PREFIX}/management/provider-model-prompts?${new URLSearchParams({ provider, model, revision })}`, signal)
}

export function previewOpenAiModelContext(input: OpenAiModelContextInput, signal?: AbortSignal): Promise<{ preview: OpenAiModelContextPreview; confirmationToken: string; confirmationExpiresAt: number }> {
  return requestJson(`${API_PREFIX}/management/models/official/preview`, { method: "POST", body: JSON.stringify(input) }, signal)
}

export function updateOpenAiModelContext(input: OpenAiModelContextInput, confirmationToken: string, signal?: AbortSignal): Promise<OpenAiModelContextResult> {
  return requestJson(`${API_PREFIX}/management/models/official/context`, { method: "POST", body: JSON.stringify({ ...input, confirmationToken }) }, signal)
}

export function previewOpenAiModelRefresh(input: OpenAiModelRefreshInput, signal?: AbortSignal): Promise<{ preview: OpenAiModelRefreshPreview; confirmationToken: string; confirmationExpiresAt: number }> {
  return requestJson(`${API_PREFIX}/management/models/official/refresh/preview`, { method: "POST", body: JSON.stringify(input) }, signal, 45_000)
}

export function refreshOpenAiModelCatalog(input: OpenAiModelRefreshInput, confirmationToken: string, signal?: AbortSignal): Promise<OpenAiModelRefreshResult> {
  return requestJson(`${API_PREFIX}/management/models/official/refresh`, { method: "POST", body: JSON.stringify({ ...input, confirmationToken }) }, signal, 45_000)
}

export function fetchCodexUserSettings(signal?: AbortSignal): Promise<CodexUserSettingsResponse> {
  return getJson<CodexUserSettingsResponse>(`${API_PREFIX}/management/codex/settings`, signal)
}

export function previewCodexUserSetting(
  revision: string,
  setting: CodexUserSettingInput,
  signal?: AbortSignal,
): Promise<ManagementSettingMutationResponse> {
  return requestJson<ManagementSettingMutationResponse>(`${API_PREFIX}/management/codex/settings/preview`, {
    method: "POST", body: JSON.stringify({ revision, setting }),
  }, signal)
}

export function updateCodexUserSetting(
  revision: string,
  setting: CodexUserSettingInput,
  confirmationToken?: string,
  signal?: AbortSignal,
): Promise<ManagementSettingMutationResponse> {
  return requestJson<ManagementSettingMutationResponse>(`${API_PREFIX}/management/codex/settings`, {
    method: "PATCH", body: JSON.stringify({ revision, setting, ...(confirmationToken === undefined ? {} : { confirmationToken }) }),
  }, signal)
}

export function fetchManagementTasks(signal?: AbortSignal): Promise<{ tasks: ManagementTask[] }> {
  return getJson<{ tasks: ManagementTask[] }>(`${API_PREFIX}/management/tasks`, signal)
}

export function previewManagementTask(input: ManagementTaskInput, signal?: AbortSignal): Promise<{ preview: ManagementTaskPreview; confirmationToken: string; confirmationExpiresAt: number }> {
  return requestJson(`${API_PREFIX}/management/tasks/preview`, { method: "POST", body: JSON.stringify(input) }, signal)
}

export function startManagementTask(input: ManagementTaskInput & { confirmationToken: string }, signal?: AbortSignal): Promise<ManagementTask> {
  return requestJson<ManagementTask>(`${API_PREFIX}/management/tasks`, { method: "POST", body: JSON.stringify(input) }, signal)
}

export function cancelManagementTask(id: string, signal?: AbortSignal): Promise<ManagementTask> {
  return requestJson<ManagementTask>(`${API_PREFIX}/management/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }, signal)
}

export function fetchManagementProviderSettings(signal?: AbortSignal): Promise<ManagementProviderSettingsResponse> {
  return getJson<ManagementProviderSettingsResponse>(`${API_PREFIX}/management/provider-settings`, signal)
}

export function fetchProviderModelTemplateOptions(provider: string, signal?: AbortSignal): Promise<ProviderModelTemplateOptionsResponse> {
  return getJson(`${API_PREFIX}/management/provider-model-templates?${new URLSearchParams({ provider })}`, signal)
}

export function fetchCustomModelDraftTemplates(signal: AbortSignal): Promise<CustomModelDraftTemplatesResponse> {
  return getJson(`${API_PREFIX}/management/provider-model-drafts`, signal)
}

export function probeManagementCustomModel(input: ManagementCustomModelProbeInput, signal: AbortSignal): Promise<ManagementCustomModelProbeResult> {
  return requestJson<ManagementCustomModelProbeResult>(`${API_PREFIX}/management/provider-settings/probe`, {
    method: "POST", body: JSON.stringify(input),
  }, signal, 50_000)
}

export function probeManagementProviderWebSearch(input: ManagementProviderWebSearchProbeInput, signal: AbortSignal): Promise<ManagementProviderWebSearchProbeResult> {
  return requestJson<ManagementProviderWebSearchProbeResult>(`${API_PREFIX}/management/provider-settings/web-search-probe`, {
    method: "POST", body: JSON.stringify(input),
  }, signal, 50_000)
}

export function previewManagementProviderSettings(
  input: ManagementProviderSettingsMutationInput,
  signal?: AbortSignal,
): Promise<ManagementProviderSettingsPreviewResponse> {
  return requestJson<ManagementProviderSettingsPreviewResponse>(`${API_PREFIX}/management/provider-settings/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  }, signal)
}

export function applyManagementProviderSettings(
  input: ManagementProviderSettingsMutationInput,
  confirmationToken: string,
  signal?: AbortSignal,
): Promise<ManagementProviderSettingsMutationResponse> {
  return requestJson<ManagementProviderSettingsMutationResponse>(`${API_PREFIX}/management/provider-settings`, {
    method: "POST",
    body: JSON.stringify({ ...input, confirmationToken }),
  }, signal)
}

export function fetchManagementAccountSettings(signal?: AbortSignal): Promise<ManagementAccountSettingsResponse> {
  return getJson<ManagementAccountSettingsResponse>(`${API_PREFIX}/management/account-settings`, signal)
}

export function previewManagementAccountSettings(
  input: ManagementAccountSettingsMutationInput,
  signal?: AbortSignal,
): Promise<ManagementAccountSettingsPreviewResponse> {
  return requestJson<ManagementAccountSettingsPreviewResponse>(`${API_PREFIX}/management/account-settings/preview`, {
    method: "POST",
    body: JSON.stringify(input),
  }, signal)
}

export function applyManagementAccountSettings(
  input: ManagementAccountSettingsMutationInput,
  confirmationToken: string,
  signal?: AbortSignal,
): Promise<ManagementAccountSettingsMutationResponse> {
  return requestJson<ManagementAccountSettingsMutationResponse>(`${API_PREFIX}/management/account-settings`, {
    method: "POST",
    body: JSON.stringify({ ...input, confirmationToken }),
  }, signal)
}

export function fetchOfficialAccountSnapshots(
  signal?: AbortSignal,
): Promise<OfficialAccountSnapshotsResponse> {
  return getJson<OfficialAccountSnapshotsResponse>(`${API_PREFIX}/accounts`, signal)
}

export function fetchOfficialAccountSources(signal?: AbortSignal): Promise<OfficialAccountSourcesResponse> {
  return getJson<OfficialAccountSourcesResponse>(`${API_PREFIX}/management/accounts/sources`, signal)
}

export function fetchTrafficExchanges(
  query: { label?: string; limit?: number; offset?: number; session?: string },
  signal?: AbortSignal,
): Promise<TrafficListResponse> {
  const params = new URLSearchParams()
  if (query.label !== undefined) params.set("label", query.label)
  if (query.limit !== undefined) params.set("limit", String(query.limit))
  if (query.offset !== undefined) params.set("offset", String(query.offset))
  if (query.session !== undefined) params.set("session", query.session)
  const suffix = params.size === 0 ? "" : `?${params.toString()}`
  return getJson<TrafficListResponse>(`${API_PREFIX}/traffic${suffix}`, signal)
}

export function fetchTrafficExchange(
  query: { traceOffset?: number; id: number; label?: string; session?: string },
  signal?: AbortSignal,
): Promise<TrafficDetailResponse> {
  const params = new URLSearchParams({ id: String(query.id) })
  if (query.traceOffset !== undefined) params.set("traceOffset", String(query.traceOffset))
  if (query.label !== undefined) params.set("label", query.label)
  if (query.session !== undefined) params.set("session", query.session)
  return getJson<TrafficDetailResponse>(
    `${API_PREFIX}/traffic/exchange?${params.toString()}`,
    signal,
  )
}

export function fetchTrafficTrace(
  query: { traceOffset?: number; id: number; label: string; session: string },
  signal?: AbortSignal,
): Promise<TrafficTraceResponse> {
  const params = new URLSearchParams({
    id: String(query.id), label: query.label, session: query.session,
    traceOffset: String(query.traceOffset ?? 0),
  })
  return getJson<TrafficTraceResponse>(`${API_PREFIX}/traffic/trace?${params.toString()}`, signal)
}

/** Returns the target Provider only; callers merge it and use GET for list membership. */
export function refreshOfficialAccountSnapshot(
  provider: string,
  signal?: AbortSignal,
): Promise<OfficialAccountSnapshotsResponse> {
  return requestJson<OfficialAccountSnapshotsResponse>(`${API_PREFIX}/management/accounts/refresh`, {
    method: "POST",
    body: JSON.stringify({ provider }),
  }, signal)
}

export function fetchRelayManagement(signal?: AbortSignal): Promise<RelayManagementSnapshot> {
  return getJson(`${API_PREFIX}/management/relay`, signal)
}
export async function probeRelayReasoning(
  input: RelayReasoningProbeInput,
  signal?: AbortSignal,
  onProgress?: (event: Extract<RelayReasoningProbeEvent, { type: "progress" }>) => void,
): Promise<RelayReasoningProbeResult> {
  const controller = new AbortController()
  const effectiveSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(140_000), ...(signal ? [signal] : [])])
  const invalid = () => new ApiClientError("Relay 思考探测响应无效或已中断", 502, "relay_probe_failed")
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancel = () => { void reader?.cancel().catch(() => {}) }
  try {
    const response = await requestResponse(`${API_PREFIX}/management/relay/reasoning-probe`, {
      method: "POST", body: JSON.stringify(input), headers: { accept: "application/x-ndjson" },
    }, effectiveSignal, 140_000)
    if (response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/x-ndjson" || !response.body) throw invalid()
    reader = response.body.getReader()
    effectiveSignal.addEventListener("abort", cancel, { once: true })
    effectiveSignal.throwIfAborted()
    const line = new Uint8Array(64 * 1024)
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    let lineBytes = 0
    let totalBytes = 0
    let result: RelayReasoningProbeResult | undefined
    while (true) {
      const next = await reader.read()
      effectiveSignal.throwIfAborted()
      if (next.done) break
      totalBytes += next.value.byteLength
      if (totalBytes > 256 * 1024) throw invalid()
      let offset = 0
      while (offset < next.value.byteLength) {
        const newline = next.value.indexOf(10, offset)
        const end = newline < 0 ? next.value.byteLength : newline
        const count = end - offset
        if (lineBytes + count + (newline < 0 ? 0 : 1) > line.byteLength) throw invalid()
        line.set(next.value.subarray(offset, end), lineBytes)
        lineBytes += count
        offset = end + (newline < 0 ? 0 : 1)
        if (newline < 0) break
        if (result !== undefined || lineBytes === 0) throw invalid()
        let event: RelayReasoningProbeEvent
        try { event = readRelayReasoningProbeEvent(JSON.parse(decoder.decode(line.subarray(0, lineBytes))), input) }
        catch { throw invalid() }
        lineBytes = 0
        if (event.type === "error") throw new ApiClientError("Relay 思考探测暂不可用", 502, event.code)
        if (event.type === "result") result = event.result
        else onProgress?.(event)
      }
    }
    if (lineBytes !== 0 || result === undefined) throw invalid()
    return result
  } finally {
    effectiveSignal.removeEventListener("abort", cancel)
    controller.abort()
    await reader?.cancel().catch(() => {})
    reader?.releaseLock()
  }
}

function readRelayReasoningProbeEvent(value: unknown, input: RelayReasoningProbeInput): RelayReasoningProbeEvent {
  const object = (candidate: unknown): candidate is Record<string, unknown> => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
  const keys = (candidate: Record<string, unknown>, names: string[]) => Object.keys(candidate).length === names.length && names.every(name => Object.hasOwn(candidate, name))
  const count = (candidate: unknown) => candidate === null || typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
  const modes = ["passthrough", "off-reasoning-effort", "off-reasoning-enabled", "off-reasoning-effort-field", "off-thinking", "off-enable-thinking", "off-chat-template-thinking", "off-google-thinking-budget", "off-reasoning-enabled-thinking"]
  if (!object(value)) throw new Error("Invalid probe event")
  if (value.type === "error" && keys(value, ["type", "code"]) && value.code === "relay_probe_failed") return { type: "error", code: value.code }
  if (value.type !== "progress" && value.type !== "result"
    || !keys(value, value.type === "progress" ? ["type", "result", "currentMode"] : ["type", "result"])) throw new Error("Invalid probe event")
  const result = value.result
  if (!object(result) || !keys(result, ["model", "protocol", "revision", "observedAtMs", "rows", "stoppedReason"])
    || result.model !== input.model || result.protocol !== input.protocol || result.revision !== input.revision
    || typeof result.observedAtMs !== "number" || !Number.isSafeInteger(result.observedAtMs) || result.observedAtMs <= 0
    || ![null, "timeout", "material_changed"].includes(result.stoppedReason as string | null)
    || !Array.isArray(result.rows) || result.rows.length !== modes.length
    || !result.rows.every((row: unknown, index: number) => object(row)
      && keys(row, ["mode", "status", "httpStatus", "reasoningText", "reasoningTokens", "outputTokens", "responseModel"])
      && row.mode === modes[index] && typeof row.status === "string" && ["completed", "incomplete", "failed", "timeout", "not_run"].includes(row.status)
      && (row.httpStatus === null || typeof row.httpStatus === "number" && Number.isInteger(row.httpStatus) && row.httpStatus >= 100 && row.httpStatus <= 599)
      && (row.reasoningText === null || typeof row.reasoningText === "boolean")
      && count(row.reasoningTokens) && count(row.outputTokens) && (row.responseModel === null || typeof row.responseModel === "string"))
    || value.type === "progress" && value.currentMode !== null && (typeof value.currentMode !== "string" || !modes.includes(value.currentMode))) throw new Error("Invalid probe result")
  return value as RelayReasoningProbeEvent
}
export function previewRelayManagement(input: RelayManagementMutation, signal?: AbortSignal): Promise<{ preview: RelayManagementPreview; confirmationToken: string }> {
  return requestJson(`${API_PREFIX}/management/relay/preview`, { method: "POST", body: JSON.stringify(input) }, signal)
}
export function applyRelayManagement(input: RelayManagementMutation, confirmationToken: string, signal?: AbortSignal): Promise<RelayManagementResult> {
  return requestJson(`${API_PREFIX}/management/relay/apply`, { method: "POST", body: JSON.stringify({ ...input, confirmationToken }) }, signal)
}

export function fetchRelayQueue(signal?: AbortSignal): Promise<RelayQueueSnapshot> {
  return getJson(`${API_PREFIX}/management/relay/queue`, signal)
}

export function fetchDeliveryQueue(before: number, state: string, signal?: AbortSignal): Promise<DeliveryQueueSnapshot> {
  const params = new URLSearchParams({ before: String(before) })
  if (state !== "all") params.set("state", state)
  return getJson(`${API_PREFIX}/management/delivery/queue?${params}`, signal)
}
export function previewDeliveryRetry(input: DeliveryRetryInput, signal?: AbortSignal): Promise<{ preview: DeliveryQueueEntry; confirmationToken: string }> {
  return requestJson(`${API_PREFIX}/management/delivery/preview`, { method: "POST", body: JSON.stringify(input) }, signal)
}
export function applyDeliveryRetry(input: DeliveryRetryInput, confirmationToken: string, signal?: AbortSignal): Promise<DeliveryRetryResult> {
  return requestJson(`${API_PREFIX}/management/delivery/retry`, { method: "POST", body: JSON.stringify({ ...input, confirmationToken }) }, signal)
}

export function previewDeliveryBatch(input: DeliveryBatchInput, signal?: AbortSignal): Promise<{ preview: DeliveryBatchPreview; confirmationToken: string }> {
  return requestJson(`${API_PREFIX}/management/delivery/batch-preview`, { method: "POST", body: JSON.stringify(input) }, signal)
}
export function applyDeliveryBatch(input: DeliveryBatchInput, confirmationToken: string, signal?: AbortSignal): Promise<DeliveryBatchResult> {
  return requestJson(`${API_PREFIX}/management/delivery/batch-apply`, { method: "POST", body: JSON.stringify({ ...input, confirmationToken }) }, signal)
}

export function fetchDeliveryContent(input: DeliveryRetryInput, signal?: AbortSignal): Promise<DeliveryContent> {
  return requestJson(`${API_PREFIX}/management/delivery/content?${new URLSearchParams({ id: input.id, revision: input.revision })}`, undefined, signal)
}

export function fetchDeliveryContents(entries: DeliveryRetryInput[], signal?: AbortSignal): Promise<DeliveryContentsResponse> {
  return requestJson(`${API_PREFIX}/management/delivery/content-batch`, { method: "POST", body: JSON.stringify({ entries }) }, signal)
}

export function fetchResetCredits(signal?: AbortSignal): Promise<ResetCreditSnapshot> {
  return getJson(`${API_PREFIX}/management/accounts/openai/reset-credits`, signal)
}
export function previewResetCredit(input: { creditId: string }, signal?: AbortSignal): Promise<{ preview: ResetCreditPreview; confirmationToken: string }> {
  return requestJson(`${API_PREFIX}/management/accounts/openai/reset-credits/preview`, { method: "POST", body: JSON.stringify(input) }, signal)
}
export function consumeResetCredit(attemptId: string, confirmationToken: string, signal?: AbortSignal): Promise<ResetCreditResult> {
  return requestJson(`${API_PREFIX}/management/accounts/openai/reset-credits/consume`, { method: "POST", body: JSON.stringify({ attemptId, confirmationToken }) }, signal)
}

export function cancelResetCredit(attemptId: string, confirmationToken: string, signal?: AbortSignal): Promise<{ cancelled: true }> {
  return requestJson(`${API_PREFIX}/management/accounts/openai/reset-credits/cancel`, { method: "POST", body: JSON.stringify({ attemptId, confirmationToken }) }, signal)
}


export function updateRelayCatalog(signal?: AbortSignal): Promise<{ auditStatus: "recorded" | "failed" }> {
  return requestJson(`${API_PREFIX}/management/relay/catalog/update`, { method: "POST", body: "{}" }, signal)
}
