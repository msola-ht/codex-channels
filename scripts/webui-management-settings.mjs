export const managedSettingKinds = new Set([
  "display.operation-updates",
  "display.plan-updates",
  "display.reasoning",
  "system.approval-timeout",
  "system.sandbox",
  "system.default-model",
  "automation.scheduled-tasks",
  "advanced.logging-level",
  "metrics.storage",
  "webui.port",
  "webui.host",
  "webui.token",
  "telegram.message-format",
  "system.default-workspace",
  "advanced.plugin-api",
  "network.proxy",
  "network.proxy-batch",
  "workspace.permissions",
])

export const highRiskManagedSettingKinds = new Set([
  "webui.host",
  "webui.token",
  "network.proxy",
  "network.proxy-batch",
  "workspace.permissions",
])

export function isHighRiskManagedSetting(input) {
  return highRiskManagedSettingKinds.has(input?.kind)
}

export function normalizeManagedSetting(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  if ((input.kind === "metrics.storage" || input.kind === "webui.token")
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
    },
    webui: {
      host: settings.webui.host,
      port: settings.webui.port,
      tokenConfigured: settings.webui.tokenConfigured,
    },
    channels: settings.channels,
  }
}
