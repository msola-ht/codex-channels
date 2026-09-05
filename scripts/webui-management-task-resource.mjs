import { inspectMetricsDatabase } from "./metrics-database-access.mjs"
import { loadServiceStatusSummary } from "./webui-service-status.mjs"

export function normalizeTaskRequestShape(input) {
  const shape = { operation: input?.operation }
  if (input?.action !== undefined) shape.action = input.action
  else if (input?.operation === "update") shape.action = "source"
  if (input?.target !== undefined) shape.target = input.target
  return shape
}

export async function managementTaskResourceState(normalized, environment, serviceStatusCache, sourceVersion, createError = defaultError) {
  if (normalized.operation === "metrics") {
    try {
      const status = inspectMetricsDatabase(environment)
      const serviceStatuses = await loadServiceStatusSummary(environment, serviceStatusCache)
      const gatewayEntry = serviceStatuses.find(({ entry }) => entry.target === "gateway")?.entry
      return {
        operation: normalized.operation,
        action: normalized.action,
        target: normalized.target ?? null,
        gateway: gatewayEntry === undefined
          ? null
          : {
              loaded: gatewayEntry.loaded,
              running: gatewayEntry.running,
              state: gatewayEntry.state,
            },
        database: {
          exists: status.exists,
          schemaVersion: status.schemaVersion,
          count: status.count,
        },
      }
    } catch {
      throw createError(503, "task_resource_unavailable", "指标数据库状态暂不可用，请稍后重试")
    }
  }
  if (normalized.operation === "service") {
    const statuses = await loadServiceStatusSummary(environment, serviceStatusCache)
    return {
      operation: normalized.operation,
      action: normalized.action,
      target: normalized.target ?? null,
      services: statuses.map(({ entry }) => ({
        target: entry.target,
        loaded: entry.loaded,
        running: entry.running,
        state: entry.state,
      })),
    }
  }
  return {
    operation: normalized.operation,
    action: normalized.action,
    sourceVersion,
  }
}

function defaultError(_status, _code, message) {
  return new Error(message)
}
