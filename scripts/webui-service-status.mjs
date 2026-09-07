import { inspectManagedServiceStatusAsync } from "./service-status.mjs"
import { serviceDefinitions } from "../runtime/service-targets.mjs"

const SERVICE_STATUS_CACHE_TTL_MS = 2_000

export function serviceVersion(target, { gatewayVersion, codexCliVersion }) {
  return target === "app-server" ? codexCliVersion : gatewayVersion
}

export function loadServiceStatusSummary(environment, cache) {
  const now = Date.now()
  if (cache.value !== null && cache.expiresAtMs > now) return Promise.resolve(cache.value)
  if (cache.pending !== null) return cache.pending
  const generation = cache.generation ?? 0
  let pending
  pending = Promise.all(serviceDefinitions.map(async (definition) => {
    try {
      const status = await inspectManagedServiceStatusAsync({ environment, target: definition.target })
      if (!status.services[0]) throw new Error("服务状态响应缺少目标条目")
      return { platform: status.platform, entry: status.services[0] }
    } catch {
      return {
        platform: null,
        entry: {
          target: definition.target,
          name: definition.displayName,
          loaded: false,
          running: false,
          state: "unavailable",
          pid: null,
        },
      }
    }
  })).then((results) => {
    if ((cache.generation ?? 0) === generation) {
      cache.value = results
      cache.expiresAtMs = Date.now() + SERVICE_STATUS_CACHE_TTL_MS
    }
    return results
  }).finally(() => {
    if (cache.pending === pending) cache.pending = null
  })
  cache.pending = pending
  return pending
}

export function invalidateServiceStatusSummary(cache) {
  cache.generation = (cache.generation ?? 0) + 1
  cache.value = null
  cache.expiresAtMs = 0
  cache.pending = null
}
