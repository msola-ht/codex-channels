import type { HttpClientProxySettings } from "../../runtime/network-proxy.mjs";

import { createProxyFetch } from "./proxy-fetch.js";

export type OpenAiConnectivityStatus =
  | "reachable"
  | "route-warning"
  | "invalid-base-url"
  | "indeterminate"
  | "unreachable"
  | "not-applicable";

export type OpenAiConnectivityRoute = "api" | "chatgpt";

const officialOpenAiBaseUrls = {
  api: "https://api.openai.com/v1",
  chatgpt: "https://chatgpt.com/backend-api/codex",
} as const;
const defaultRetryDelaysMs = [1_000, 2_000, 4_000] as const;

export interface OpenAiConnectivityOptions {
  proxy: HttpClientProxySettings;
  route: OpenAiConnectivityRoute;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  deadlineMs?: number;
  retryDelaysMs?: readonly number[];
  signal?: AbortSignal;
}

export async function checkOpenAiConnectivity(
  options: OpenAiConnectivityOptions,
): Promise<OpenAiConnectivityStatus> {
  const fetchImpl = options.fetchImpl ?? createProxyFetch(options.proxy);
  const deadlineAt = Date.now() + (options.deadlineMs ?? 12_000);
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;
  const plan = connectivityPlan(options);

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(options.signal);
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      return "unreachable";
    }
    const result = await probeOpenAiRoute(
      plan,
      fetchImpl,
      Math.min(options.timeoutMs ?? 5_000, remainingMs),
      options.signal,
    );
    if (result !== "unreachable") {
      return result;
    }
    const retryDelayMs = retryDelaysMs[attempt];
    if (retryDelayMs === undefined || Date.now() + retryDelayMs >= deadlineAt) {
      return result;
    }
    await abortableDelay(retryDelayMs, options.signal);
  }
}

interface ConnectivityPlan {
  inferenceUrl: string;
  routeProbeUrl?: string;
}

function connectivityPlan(options: OpenAiConnectivityOptions): ConnectivityPlan {
  const baseUrl = options.baseUrl ?? officialOpenAiBaseUrls[options.route];
  return {
    inferenceUrl: appendUrlPath(baseUrl, "responses"),
    ...(options.baseUrl !== undefined || options.route === "api"
      ? { routeProbeUrl: appendUrlPath(baseUrl, "models") }
      : {}),
  };
}

function appendUrlPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path}`;
}

async function probeOpenAiRoute(
  plan: ConnectivityPlan,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Exclude<OpenAiConnectivityStatus, "indeterminate" | "not-applicable">> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, timeoutMs);
  timeout.unref();
  try {
    const inference = await requestAndDiscard(fetchImpl, plan.inferenceUrl, "HEAD", controller.signal);
    if (inference.status >= 500) {
      return "route-warning";
    }
    if (plan.routeProbeUrl === undefined) {
      return "reachable";
    }
    const response = await requestAndDiscard(
      fetchImpl,
      plan.routeProbeUrl,
      "GET",
      controller.signal,
    );
    if (
      (response.status >= 200 && response.status < 300)
      || response.status === 401
      || response.status === 403
    ) {
      return "reachable";
    }
    return response.status === 404 ? "invalid-base-url" : "route-warning";
  } catch (error) {
    if (signal?.aborted) {
      throw abortError(signal, error);
    }
    return "unreachable";
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

async function requestAndDiscard(
  fetchImpl: typeof fetch,
  url: string,
  method: "GET" | "HEAD",
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetchImpl(url, {
    method,
    redirect: "manual",
    signal,
  });
  await response.body?.cancel().catch(() => undefined);
  return response;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal, fallback?: unknown): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  return fallback instanceof Error ? fallback : new Error("OpenAI 连通探测已取消");
}

function abortableDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal ? abortError(signal) : new Error("OpenAI 连通探测已取消"));
    };
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
