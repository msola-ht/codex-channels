import type {
  ErrorsResponse,
  OverviewResponse,
  RangeName,
  RequestsResponse,
  ThreadRunResponse,
  ThreadsResponse,
  ThreadTurnsResponse,
} from "@/lib/types"

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

const TOKEN_KEY = "codex-webui:token"
export const API_PREFIX = "/api/v1"
let unauthorizedHandler: (() => void) | null = null

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    // 存储不可用时仅本次会话内保留
  }
}

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = getToken()
  const timeoutSignal = AbortSignal.timeout(30_000)
  const effectiveSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal])
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
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

export function fetchOverview(
  range: RangeName,
  signal?: AbortSignal,
): Promise<OverviewResponse> {
  return getJson<OverviewResponse>(`${API_PREFIX}/overview?range=${range}`, signal)
}

export function fetchThreads(signal?: AbortSignal): Promise<ThreadsResponse> {
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
  afterId: number | null,
  limit: number,
  signal?: AbortSignal,
): Promise<RequestsResponse> {
  const params = new URLSearchParams({ range, limit: String(limit) })
  if (afterId !== null) params.set("afterId", String(afterId))
  return getJson<RequestsResponse>(`${API_PREFIX}/requests?${params.toString()}`, signal)
}

export function fetchErrors(
  range: RangeName,
  signal?: AbortSignal,
): Promise<ErrorsResponse> {
  return getJson<ErrorsResponse>(`${API_PREFIX}/errors?range=${range}`, signal)
}
