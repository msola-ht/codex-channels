export const managedSettingKinds = new Set([
  "display.preset",
  "display.operation-updates",
  "display.plan-updates",
  "display.reasoning",
  "display.scope",
  "display.completion",
  "display.presentation-detail",
  "display.subagents",
  "display.streaming",
  "display.commentary",
  "display.routine-notifications",
  "display.model-aliases",
  "system.approval-timeout",
  "system.idle-release-minutes",
  "system.default-model",
  "system.model-traffic-dump",
  "system.model-traffic-mode",
  "system.model-traffic-retention-days",
  "system.official-tui-identity",
  "automation.scheduled-tasks",
  "advanced.logging-level",
  "metrics.storage",
  "webui.port",
  "webui.host",
  "webui.token",
  "telegram.message-format",
  "system.default-workspace",
  "network.proxy",
  "network.proxy-batch",
])

export const highRiskManagedSettingKinds = new Set([
  "display.preset",
  "display.scope",
  "display.completion",
  "display.presentation-detail",
  "display.subagents",
  "display.streaming",
  "display.commentary",
  "display.routine-notifications",
  "system.official-tui-identity",
  "automation.scheduled-tasks",
  "webui.host",
  "webui.token",
  "network.proxy",
  "network.proxy-batch",
])

export function isHighRiskManagedSetting(input) {
  return highRiskManagedSettingKinds.has(input?.kind)
}

export function normalizeManagedSetting(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  if ((input.kind === "metrics.storage"
    || input.kind === "webui.token"
    || input.kind === "network.proxy"
    || input.kind === "network.proxy-batch")
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
      idleReleaseMinutes: settings.system.idleReleaseMinutes,
      defaultWorkspace: settings.system.defaultWorkspace,
      defaultModel: settings.system.defaultModel,
      modelTrafficMode: settings.system.modelTrafficMode,
      modelTrafficInputItems: settings.system.modelTrafficInputItems,
      modelTrafficItemMaxBytes: settings.system.modelTrafficItemMaxBytes,
      modelTrafficDumpEnabled: settings.system.modelTrafficDumpEnabled,
      modelTrafficRetentionDays: settings.system.modelTrafficRetentionDays,
      officialTuiIdentity: settings.system.officialTuiIdentity,
      workspaces: settings.system.workspaces,
    },
    automation: {
      scheduledTasksEnabled: settings.automation.scheduledTasksEnabled,
    },
    advanced: {
      loggingLevel: settings.advanced.loggingLevel,
    },
    network: {
      configuredFields: Object.entries(settings.network)
        .filter(([, value]) => value.configured)
        .map(([field]) => field),
    },
    telegram: settings.telegram,
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
