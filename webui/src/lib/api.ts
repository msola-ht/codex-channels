import type {
  DeepseekBalanceResponse,
  ErrorsResponse,
  OpencodeGoUsageResponse,
  OfficialAccountSnapshotsResponse,
  OverviewResponse,
  RangeName,
  RequestSortDirection,
  RequestSortKey,
  RequestsResponse,
  SettingsSummaryResponse,
  ManagementSettingsResponse,
  ManagementServicesResponse,
  ManagementProvidersResponse,
  ManagementSettingInput,
  ManagementSettingMutationResponse,
  CodexUserSettingsResponse,
  CodexUserSettingInput,
  ManagementTask,
  ManagementTaskInput,
  ManagementTaskPreview,
  ManagementApiProviderMutationInput,
  ManagementApiProviderPreviewResponse,
  ManagementApiProviderMutationResponse,
  ManagementApiProvider,
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
} from "@/lib/types"
import { getToken } from "@/lib/token-storage"

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
  range: RangeName,
  signal?: AbortSignal,
): Promise<OverviewResponse> {
  return getJson<OverviewResponse>(
    `${API_PREFIX}/overview?range=${range}`,
    signal,
  )
}

export function fetchThreads(
  signal?: AbortSignal,
): Promise<ThreadsResponse> {
  return getJson<ThreadsResponse>(`${API_PREFIX}/threads`, signal)
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
  signal?: AbortSignal,
): Promise<ThreadTurnsResponse> {
  return getJson<ThreadTurnsResponse>(
    `${API_PREFIX}/threads/${encodeURIComponent(threadId)}/turns`,
    signal,
  )
}

export function fetchRequests(
  range: RangeName,
  offset: number,
  limit: number,
  sort: RequestSortKey,
  direction: RequestSortDirection,
  filter: string,
  signal?: AbortSignal,
): Promise<RequestsResponse> {
  const params = new URLSearchParams({
    range,
    offset: String(offset),
    limit: String(limit),
    sort,
    direction,
  })
  if (filter.trim() !== "") params.set("filter", filter.trim())
  return getJson<RequestsResponse>(`${API_PREFIX}/requests?${params.toString()}`, signal)
}

export function fetchErrors(
  range: RangeName,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<ErrorsResponse> {
  const params = new URLSearchParams({
    range,
    offset: String(offset),
    limit: String(limit),
  })
  return getJson<ErrorsResponse>(
    `${API_PREFIX}/errors?${params.toString()}`,
    signal,
  )
}

export function fetchSettingsSummary(signal?: AbortSignal): Promise<SettingsSummaryResponse> {
  return getJson<SettingsSummaryResponse>(`${API_PREFIX}/settings/summary`, signal)
}

export function fetchManagementServices(signal?: AbortSignal): Promise<ManagementServicesResponse> {
  return getJson<ManagementServicesResponse>(`${API_PREFIX}/management/services`, signal)
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
  signal?: AbortSignal,
): Promise<ManagementSettingMutationResponse> {
  return requestJson<ManagementSettingMutationResponse>(`${API_PREFIX}/management/codex/settings`, {
    method: "PATCH", body: JSON.stringify({ revision, setting }),
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

export function fetchManagementApiProviders(signal?: AbortSignal): Promise<{ providers: ManagementApiProvider[] }> {
  return getJson<{ providers: ManagementApiProvider[] }>(`${API_PREFIX}/management/api-providers`, signal)
}

export function previewManagementApiProvider(input: ManagementApiProviderMutationInput, signal?: AbortSignal): Promise<ManagementApiProviderPreviewResponse> {
  return requestJson<ManagementApiProviderPreviewResponse>(`${API_PREFIX}/management/api-providers/preview`, { method: "POST", body: JSON.stringify(input) }, signal)
}

export function applyManagementApiProvider(input: ManagementApiProviderMutationInput, confirmationToken: string, signal?: AbortSignal): Promise<ManagementApiProviderMutationResponse> {
  return requestJson<ManagementApiProviderMutationResponse>(`${API_PREFIX}/management/api-providers`, { method: "POST", body: JSON.stringify({ ...input as object, confirmationToken }) }, signal)
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

export function fetchDeepseekBalance(
  signal?: AbortSignal,
): Promise<DeepseekBalanceResponse> {
  return getJson<DeepseekBalanceResponse>(
    `${API_PREFIX}/deepseek-balance`,
    signal,
  )
}

export function fetchOpencodeGoUsage(
  signal?: AbortSignal,
): Promise<OpencodeGoUsageResponse> {
  return getJson<OpencodeGoUsageResponse>(
    `${API_PREFIX}/opencode-go-usage`,
    signal,
  )
}

export function fetchOfficialAccountSnapshots(
  signal?: AbortSignal,
): Promise<OfficialAccountSnapshotsResponse> {
  return getJson<OfficialAccountSnapshotsResponse>(`${API_PREFIX}/accounts`, signal)
}
