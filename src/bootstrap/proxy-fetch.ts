import {
  fetch as undiciFetch,
  ProxyAgent,
  type Dispatcher,
} from "undici";

import {
  selectHttpProxyUrl,
  type HttpClientProxySettings,
} from "../../runtime/network-proxy.mjs";

export function createProxyFetch(
  proxy: HttpClientProxySettings,
  dependencies: ProxyFetchDependencies = {},
): typeof fetch {
  const directFetch = dependencies.directFetch ?? fetch;
  const fetchWithDispatcher = dependencies.fetchWithDispatcher
    ?? defaultFetchWithDispatcher;
  const createDispatcher = dependencies.createDispatcher
    ?? ((proxyUrl: string) => new ProxyAgent(proxyUrl));
  const dispatchers = new Map<string, Dispatcher>();
  const proxyFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const proxyUrl = selectHttpProxyUrl(proxy, requestUrl(input));
    if (!proxyUrl) {
      return await directFetch(input, init);
    }
    let dispatcher = dispatchers.get(proxyUrl);
    if (!dispatcher) {
      dispatcher = createDispatcher(proxyUrl);
      dispatchers.set(proxyUrl, dispatcher);
    }
    return await fetchWithDispatcher(input, { ...init, dispatcher });
  };
  return proxyFetch;
}

export interface ProxyFetchDependencies {
  directFetch?: typeof fetch;
  fetchWithDispatcher?: (
    input: RequestInfo | URL,
    init: RequestInit & { dispatcher: Dispatcher },
  ) => Promise<Response>;
  createDispatcher?: (proxyUrl: string) => Dispatcher;
}

async function defaultFetchWithDispatcher(
  input: RequestInfo | URL,
  init: RequestInit & { dispatcher: Dispatcher },
): Promise<Response> {
  return await undiciFetch(
    input as unknown as Parameters<typeof undiciFetch>[0],
    init as Parameters<typeof undiciFetch>[1],
  ) as unknown as Response;
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  return new URL(typeof input === "string" ? input : input.url);
}
