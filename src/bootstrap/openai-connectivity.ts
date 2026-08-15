import type { HttpClientProxySettings } from "../../runtime/network-proxy.mjs";

import { createProxyFetch } from "./proxy-fetch.js";

export type OpenAiConnectivityStatus =
  | "reachable"
  | "partial"
  | "unreachable"
  | "not-applicable";

const officialOpenAiTargets = [
  "https://chatgpt.com/backend-api/codex",
  "https://api.openai.com/v1",
] as const;

export interface OpenAiConnectivityOptions {
  proxy: HttpClientProxySettings;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkOpenAiConnectivity(
  options: OpenAiConnectivityOptions,
): Promise<OpenAiConnectivityStatus> {
  const targets = options.baseUrl
    ? [options.baseUrl]
    : officialOpenAiTargets;
  const fetchImpl = options.fetchImpl ?? createProxyFetch(options.proxy);
  const results = await Promise.all(targets.map((target) =>
    probeHttpTransport(target, fetchImpl, options.timeoutMs ?? 5_000)
  ));
  const reachableCount = results.filter(Boolean).length;
  if (reachableCount === 0) {
    return "unreachable";
  }
  return reachableCount === results.length ? "reachable" : "partial";
}

async function probeHttpTransport(
  target: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  try {
    const response = await fetchImpl(target, {
      method: "HEAD",
      redirect: "manual",
      signal: controller.signal,
    });
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
