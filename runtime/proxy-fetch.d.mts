import type { Dispatcher } from "undici";

import type { HttpClientProxySettings } from "./network-proxy.mjs";

export interface ProxyFetchDependencies {
  directFetch?: typeof fetch;
  fetchWithDispatcher?: (
    input: RequestInfo | URL,
    init: RequestInit & { dispatcher: Dispatcher },
  ) => Promise<Response>;
  createDispatcher?: (proxyUrl: string) => Dispatcher;
}

export function createProxyFetch(
  proxy: HttpClientProxySettings,
  dependencies?: ProxyFetchDependencies,
): typeof fetch;
