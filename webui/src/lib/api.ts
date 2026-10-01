import type { ResetCreditSnapshot, ResetCreditPreview, ResetCreditResult } from "./types"
import type {
  QueueChangeEvent,
  DeliveryContentsResponse, DeliveryContent, DeliveryBatchInput, DeliveryBatchPreview, DeliveryBatchResult, DeliveryQueueEntry, DeliveryQueueSnapshot, DeliveryRetryInput, DeliveryRetryResult,
  RelayQueueSnapshot, RelayManagementSnapshot, RelayManagementMutation, RelayManagementPreview, RelayManagementResult,
  ServerTimeResponse,
  ErrorsResponse,
  OfficialAccountSnapshotsResponse,
  OverviewResponse,
  MetricsRangeQuery,
  MetricsQuery,
  MetricsProvidersResponse,
  RequestsResponse,
  SettingsSummaryResponse,
  ManagementSettingsResponse,
  ManagementServicesResponse,
  ManagementProvidersResponse,
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
  ThreadsResponse,
  ThreadTurnsResponse,
  TrafficDetailResponse,
  TrafficTraceResponse,
  TrafficTurnStatesResponse,
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
let unauthorizedHandler: (() => void) | null = null

export const watchDeliveryQueue = (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchQueue("delivery/events", signal, receive)
export const watchRelayQueue = (signal: AbortSignal, receive: (event: QueueChangeEvent) => void) => watchQueue("relay/queue/events", signal, receive)

/** Fetch-based SSE keeps credentials in the Authorization header, never in the URL. */
async function watchQueue(path: string, signal: AbortSignal, receive: (event: QueueChangeEvent) => void): Promise<void> {
  const controller = new AbortController()
  let idle = setTimeout(() => controller.abort(), 35_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const headers = new Headers({ accept: "text/event-stream" })
    const token = getToken()
    if (token !== null) headers.set("authorization", `Bearer ${token}`)
    const response = await fetch(`${API_PREFIX}/management/${path}`, { headers, cache: "no-store", signal: AbortSignal.any([signal, controller.signal]) })
    if (response.status === 401) unauthorizedHandler?.()
    if (!response.ok) throw new ApiClientError("Queue notifications unavailable", response.status, path.startsWith("relay/") ? "relay_unavailable" : "delivery_unavailable")
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
      if (buffer.length > 4096) throw new Error("Queue stream frame too large")
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (!frame.startsWith("data: ")) throw new Error("Invalid queue event")
        const event: unknown = JSON.parse(frame.slice(6))
        if (!event || typeof event !== "object" || !("type" in event) || Object.keys(event).length !== 1 || !["changed", "heartbeat", "unavailable"].includes(String(event.type))) throw new Error("Invalid queue event")
        if (event.type === "unavailable") throw new Error("Queue notifications unavailable")
        receive(event as QueueChangeEvent)
      }
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

async function requestJson<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const token = getToken()
  const timeoutSignal = AbortSignal.timeout(30_000)
  const effectiveSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal])
  const headers = new Headers(init.headers)
  headers.set("accept", "application/json")
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
  return await response.json() as T
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, {}, signal)
}

export function fetchServerTime(signal?: AbortSignal): Promise<ServerTimeResponse> {
  return getJson<ServerTimeResponse>(`${API_PREFIX}/time`, signal)
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

export function fetchMetricsExport(query: MetricsQuery, signal?: AbortSignal): Promise<unknown> {
  return getJson(`${API_PREFIX}/requests/export?${metricsQueryParams(query)}`, signal)
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

export function fetchManagementServices(signal?: AbortSignal): Promise<ManagementServicesResponse> {
  return getJson<ManagementServicesResponse>(`${API_PREFIX}/management/services`, signal)
}

export function fetchUpstreamUserAgent(signal?: AbortSignal): Promise<UpstreamUserAgentResponse> {
  return getJson<UpstreamUserAgentResponse>(`${API_PREFIX}/management/upstream-user-agent`, signal)
}

export function fetchManagementProviders(signal?: AbortSignal): Promise<ManagementProvidersResponse> {
  return getJson<ManagementProvidersResponse>(`${API_PREFIX}/management/providers`, signal)
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

export function fetchTrafficTurnStates(
  query: { label: string; session: string; ids: number[] },
  signal?: AbortSignal,
): Promise<TrafficTurnStatesResponse> {
  const params = new URLSearchParams({ label: query.label, session: query.session, ids: query.ids.join(",") })
  return getJson<TrafficTurnStatesResponse>(`${API_PREFIX}/traffic/turn-state?${params.toString()}`, signal)
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
