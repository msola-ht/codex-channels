export type ConfigChangeCode =
  | "codex.binary"
  | "codex.socket"
  | "codex.default-model"
  | "codex.sandbox"
  | "network.proxy"
  | "storage.database"
  | "approval.timeout"
  | "observability.log-level"
  | "workspace.default"
  | "workspace.registry"
  | "surface.telegram.token"
  | "surface.telegram.proxy"
  | "surface.telegram.message-format"
  | "surface.telegram.allowed-users";

export type ConfigChangeScope = "global" | "telegram";

export interface ConfigChange {
  code: ConfigChangeCode;
  scope: ConfigChangeScope;
}

export function configChange(
  code: ConfigChangeCode,
  scope: ConfigChangeScope = "global",
): ConfigChange {
  return { code, scope };
}

export function includesConfigChange(
  changes: readonly ConfigChange[],
  code: ConfigChangeCode,
): boolean {
  return changes.some((change) => change.code === code);
}
