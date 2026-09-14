import { fetch as undiciFetch, ProxyAgent } from "undici";

import { selectHttpProxyUrl } from "./network-proxy.mjs";

export function createProxyFetch(proxy, dependencies = {}) {
  const directFetch = dependencies.directFetch ?? fetch;
  const fetchWithDispatcher = dependencies.fetchWithDispatcher
    ?? defaultFetchWithDispatcher;
  const createDispatcher = dependencies.createDispatcher
    ?? ((proxyUrl) => new ProxyAgent(proxyUrl));
  const dispatchers = new Map();
  return async (input, init) => {
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
}

async function defaultFetchWithDispatcher(input, init) {
  return await undiciFetch(input, init);
}

function requestUrl(input) {
  if (input instanceof URL) {
    return input;
  }
  return new URL(typeof input === "string" ? input : input.url);
}
