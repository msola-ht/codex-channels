export type GlobalConfigChangeCode =
  | "codex.binary"
  | "codex.socket"
  | "codex.default-model"
  | "codex.sandbox"
  | "network.proxy"
  | "storage.database"
  | "approval.timeout"
  | "display.operation-updates"
  | "display.plan-updates"
  | "api.providers"
  | "vision.provider"
  | "metrics.sync"
  | "observability.log-level"
  | "workspace.default"
  | "workspace.registry";

export type TelegramConfigChangeCode =
  | "surface.telegram.enabled"
  | "surface.telegram.token"
  | "surface.telegram.proxy"
  | "surface.telegram.message-format"
  | "surface.telegram.allowed-users";

export type FeishuConfigChangeCode =
  | "surface.feishu.enabled"
  | "surface.feishu.credentials"
  | "surface.feishu.allowed-users";

export type WeixinConfigChangeCode =
  | "surface.weixin.enabled"
  | "surface.weixin.account"
  | "surface.weixin.allowed-users";

export type ConfigChangeCode =
  | GlobalConfigChangeCode
  | TelegramConfigChangeCode
  | FeishuConfigChangeCode
  | WeixinConfigChangeCode;

export type ConfigChangeScope = "global" | "telegram" | "feishu" | "weixin";

export type ConfigChange =
  | { code: GlobalConfigChangeCode; scope: "global" }
  | { code: TelegramConfigChangeCode; scope: "telegram" }
  | { code: FeishuConfigChangeCode; scope: "feishu" }
  | { code: WeixinConfigChangeCode; scope: "weixin" };

export function configChange(code: GlobalConfigChangeCode): ConfigChange;
export function configChange(
  code: TelegramConfigChangeCode,
  scope: "telegram",
): ConfigChange;
export function configChange(
  code: FeishuConfigChangeCode,
  scope: "feishu",
): ConfigChange;
export function configChange(
  code: WeixinConfigChangeCode,
  scope: "weixin",
): ConfigChange;
export function configChange(
  code: ConfigChangeCode,
  scope: ConfigChangeScope = "global",
): ConfigChange {
  const expectedScope = code.startsWith("surface.telegram.")
    ? "telegram"
    : code.startsWith("surface.feishu.")
      ? "feishu"
      : code.startsWith("surface.weixin.")
        ? "weixin"
      : "global";
  if (scope !== expectedScope) {
    throw new Error(`配置变更 ${code} 的 scope 必须为 ${expectedScope}`);
  }
  return { code, scope } as ConfigChange;
}

export function includesConfigChange(
  changes: readonly ConfigChange[],
  code: ConfigChangeCode,
): boolean {
  return changes.some((change) => change.code === code);
}
