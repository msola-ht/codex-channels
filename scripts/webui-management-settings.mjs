export const managedSettingKinds = new Set([
  "display.operation-updates",
  "display.plan-updates",
  "display.reasoning",
  "display.price-currency",
  "system.approval-timeout",
  "system.sandbox",
  "system.default-model",
  "automation.scheduled-tasks",
  "advanced.logging-level",
  "metrics.storage",
  "metrics.sync-params",
  "webui.port",
  "webui.host",
  "webui.token",
  "telegram.message-format",
  "system.default-workspace",
  "automation.thread-section-administrators",
  "advanced.plugin-api",
  "network.proxy",
  "network.proxy-batch",
  "metrics.connect",
  "metrics.disconnect",
  "metrics.center.host",
  "metrics.center.port",
  "metrics.center.token",
  "metrics.center.generate-tokens",
  "workspace.permissions",
])

export const highRiskManagedSettingKinds = new Set([
  "webui.host",
  "webui.token",
  "network.proxy",
  "network.proxy-batch",
  "metrics.connect",
  "metrics.disconnect",
  "metrics.center.token",
  "metrics.center.generate-tokens",
  "workspace.permissions",
])

export function isHighRiskManagedSetting(input) {
  return highRiskManagedSettingKinds.has(input?.kind)
}

export function normalizeManagedSetting(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  if ((input.kind === "metrics.storage" || input.kind === "metrics.sync-params")
    && input.value !== null && typeof input.value === "object" && !Array.isArray(input.value)) {
    return { ...input.value, kind: input.kind }
  }
  return input
}

export function redactManagedSettings(settings) {
  return {
    revision: settings.revision,
    display: settings.display,
    system: {
      approvalTimeoutSeconds: settings.system.approvalTimeoutSeconds,
      sandbox: settings.system.sandbox,
      defaultWorkspace: settings.system.defaultWorkspace,
      defaultModel: settings.system.defaultModel,
      workspaces: settings.system.workspaces,
    },
    automation: {
      scheduledTasksEnabled: settings.automation.scheduledTasksEnabled,
      threadSectionAdministratorCount: settings.automation.threadSectionAdministrators.length,
    },
    advanced: {
      loggingLevel: settings.advanced.loggingLevel,
      pluginApiEnabled: settings.advanced.pluginApiEnabled,
    },
    network: {
      configuredFields: Object.entries(settings.network)
        .filter(([, value]) => value.configured)
        .map(([field]) => field),
    },
    metrics: {
      storage: settings.metrics.storage,
      sync: {
        enabled: settings.metrics.sync.enabled,
        endpointConfigured: settings.metrics.sync.endpoint !== null,
        deviceName: settings.metrics.sync.deviceName,
        deviceTokenConfigured: settings.metrics.sync.deviceTokenConfigured,
        intervalSeconds: settings.metrics.sync.intervalSeconds,
        batchSize: settings.metrics.sync.batchSize,
      },
      view: {
        enabled: settings.metrics.view.enabled,
        endpointConfigured: settings.metrics.view.endpoint !== null,
        tokenConfigured: settings.metrics.view.tokenConfigured,
      },
      center: {
        enabled: settings.metrics.center.enabled,
        host: settings.metrics.center.host,
        port: settings.metrics.center.port,
        tokenConfigured: settings.metrics.center.tokenConfigured,
        deviceTokenConfigured: settings.metrics.center.deviceTokenConfigured,
      },
    },
    webui: {
      host: settings.webui.host,
      port: settings.webui.port,
      tokenConfigured: settings.webui.tokenConfigured,
    },
    channels: settings.channels,
  }
}
