import {
  configChange,
  type ConfigChange,
} from "./config-change.js";
import type { GatewayConfig } from "./index.js";

export type ConfigReloadResult =
  | { action: "reload"; changes: ConfigChange[] }
  | { action: "restart"; changes: ConfigChange[] }
  | { action: "reinstall"; changes: ConfigChange[] };

export function classifyConfigReload(
  current: GatewayConfig,
  next: GatewayConfig,
): ConfigReloadResult {
  const reinstallReasons = serviceReinstallReasons(current, next);
  const restartReasons = restartRequiredReasons(current, next);
  const reloadReasons = hotReloadReasons(current, next);
  if (reinstallReasons.length > 0) {
    return {
      action: "reinstall",
      changes: [...reinstallReasons, ...restartReasons, ...reloadReasons],
    };
  }
  if (restartReasons.length > 0) {
    return {
      action: "restart",
      changes: [...restartReasons, ...reloadReasons],
    };
  }
  return { action: "reload", changes: reloadReasons };
}

function serviceReinstallReasons(
  current: GatewayConfig,
  next: GatewayConfig,
): ConfigChange[] {
  const reasons: ConfigChange[] = [];
  if (current.codexBinary !== next.codexBinary) {
    reasons.push(configChange("codex.binary"));
  }
  if (current.codexSocketPath !== next.codexSocketPath) {
    reasons.push(configChange("codex.socket"));
  }
  if (!sameNetworkProxy(current.networkProxy, next.networkProxy)) {
    reasons.push(configChange("network.proxy"));
  }
  return reasons;
}

function sameNetworkProxy(
  current: GatewayConfig["networkProxy"],
  next: GatewayConfig["networkProxy"],
): boolean {
  return current.http === next.http
    && current.https === next.https
    && current.all === next.all
    && current.no === next.no;
}

function restartRequiredReasons(
  current: GatewayConfig,
  next: GatewayConfig,
): ConfigChange[] {
  const reasons: ConfigChange[] = [];
  const telegramEnabledChanged = current.telegramEnabled !== next.telegramEnabled;
  if (telegramEnabledChanged) {
    reasons.push(configChange("surface.telegram.enabled", "telegram"));
  }
  const fields: Array<[ConfigChange, unknown, unknown]> = [
    ...(current.telegramEnabled && next.telegramEnabled
      ? [
          [configChange("surface.telegram.token", "telegram"), current.telegramBotToken, next.telegramBotToken],
          [configChange("surface.telegram.proxy", "telegram"), current.telegramProxyUrl, next.telegramProxyUrl],
          [configChange("surface.telegram.message-format", "telegram"), current.telegramMessageFormat, next.telegramMessageFormat],
        ] as Array<[ConfigChange, unknown, unknown]>
      : []),
    [configChange("surface.feishu.enabled", "feishu"), current.feishu !== undefined, next.feishu !== undefined],
    [configChange("surface.weixin.enabled", "weixin"), current.weixin !== undefined, next.weixin !== undefined],
    [configChange("codex.default-model"), current.codexModel, next.codexModel],
    [configChange("codex.sandbox"), current.codexSandbox, next.codexSandbox],
    [configChange("storage.database"), current.stateDatabasePath, next.stateDatabasePath],
    [configChange("approval.timeout"), current.approvalTimeoutMs, next.approvalTimeoutMs],
    [
      configChange("display.operation-updates"),
      current.operationUpdateDisplay,
      next.operationUpdateDisplay,
    ],
    [
      configChange("display.plan-updates"),
      current.planUpdatesEnabled,
      next.planUpdatesEnabled,
    ],
    [
      configChange("experimental.plugin-api"),
      current.pluginApiEnabled,
      next.pluginApiEnabled,
    ],
    [configChange("observability.log-level"), current.logLevel, next.logLevel],
    [
      configChange("api.providers"),
      JSON.stringify(current.apiProviders),
      JSON.stringify(next.apiProviders),
    ],
    [
      configChange("vision.provider"),
      JSON.stringify(current.vision),
      JSON.stringify(next.vision),
    ],
    [
      configChange("metrics.sync"),
      JSON.stringify(current.metricsSync),
      JSON.stringify(next.metricsSync),
    ],
    [
      configChange("metrics.storage"),
      JSON.stringify(current.metricsStorage),
      JSON.stringify(next.metricsStorage),
    ],
    [configChange("workspace.default"), current.defaultWorkspaceId, next.defaultWorkspaceId],
  ];
  for (const [change, before, after] of fields) {
    if (before !== after) {
      reasons.push(change);
    }
  }
  if (
    current.feishu !== undefined
    && next.feishu !== undefined
    && (
      current.feishu.appId !== next.feishu.appId
      || current.feishu.appSecret !== next.feishu.appSecret
    )
  ) {
    reasons.push(configChange("surface.feishu.credentials", "feishu"));
  }
  if (
    current.weixin !== undefined
    && next.weixin !== undefined
    && current.weixin.accountId !== next.weixin.accountId
  ) {
    reasons.push(configChange("surface.weixin.account", "weixin"));
  }
  if (
    current.weixin !== undefined
    && next.weixin !== undefined
    && ![...current.weixin.allowedUserIds].every(
      (userId) => next.weixin!.allowedUserIds.has(userId),
    )
  ) {
    reasons.push(configChange("surface.weixin.allowed-users", "weixin"));
  }
  if (!preservesExistingWorkspaces(current.workspaces, next.workspaces)) {
    reasons.push(configChange("workspace.registry"));
  }
  if (
    !telegramEnabledChanged
    && current.telegramEnabled
    && ![...current.telegramAllowedUserIds].every(
      (userId) => next.telegramAllowedUserIds.has(userId),
    )
  ) {
    reasons.push(configChange("surface.telegram.allowed-users", "telegram"));
  }
  return reasons;
}

function hotReloadReasons(
  current: GatewayConfig,
  next: GatewayConfig,
): ConfigChange[] {
  const reasons: ConfigChange[] = [];
  if (
    preservesExistingWorkspaces(current.workspaces, next.workspaces)
    && !sameWorkspaces(current.workspaces, next.workspaces)
  ) {
    reasons.push(configChange("workspace.registry"));
  }
  if (
    current.telegramEnabled
    && next.telegramEnabled
    && [...current.telegramAllowedUserIds].every(
      (userId) => next.telegramAllowedUserIds.has(userId),
    )
    && !sameSet(current.telegramAllowedUserIds, next.telegramAllowedUserIds)
  ) {
    reasons.push(configChange("surface.telegram.allowed-users", "telegram"));
  }
  if (
    current.feishu !== undefined
    && next.feishu !== undefined
    && !sameSet(
      current.feishu.allowedOpenIds,
      next.feishu.allowedOpenIds,
    )
  ) {
    reasons.push(configChange("surface.feishu.allowed-users", "feishu"));
  }
  if (
    current.weixin !== undefined
    && next.weixin !== undefined
    && [...current.weixin.allowedUserIds].every(
      (userId) => next.weixin!.allowedUserIds.has(userId),
    )
    && !sameSet(
      current.weixin.allowedUserIds,
      next.weixin.allowedUserIds,
    )
  ) {
    reasons.push(configChange("surface.weixin.allowed-users", "weixin"));
  }
  return reasons;
}

function preservesExistingWorkspaces(
  current: GatewayConfig["workspaces"],
  next: GatewayConfig["workspaces"],
): boolean {
  const byId = new Map(next.map((workspace) => [workspace.id, workspace]));
  return current.every((workspace) => {
    const candidate = byId.get(workspace.id);
    return candidate?.name === workspace.name && candidate.cwd === workspace.cwd;
  });
}

function sameWorkspaces(
  current: GatewayConfig["workspaces"],
  next: GatewayConfig["workspaces"],
): boolean {
  return current.length === next.length && current.every((workspace, index) => {
    const candidate = next[index];
    return candidate?.id === workspace.id
      && candidate.name === workspace.name
      && candidate.cwd === workspace.cwd
      && candidate.sandbox === workspace.sandbox
      && candidate.approvalPolicy === workspace.approvalPolicy
      && candidate.permissions === workspace.permissions;
  });
}

function sameSet<T>(
  current: ReadonlySet<T>,
  next: ReadonlySet<T>,
): boolean {
  return current.size === next.size
    && [...current].every((value) => next.has(value));
}
