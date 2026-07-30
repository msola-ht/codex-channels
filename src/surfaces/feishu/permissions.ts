export interface FeishuPermissionRuntimeStatus {
  connectionReady: boolean;
  cardActionObserved: boolean;
  menuEventObserved: boolean;
}

export type FeishuUserAuthorizationStatus =
  | "pending"
  | "missing"
  | "valid"
  | "refreshable"
  | "expired"
  | "unavailable";

const userAuthorizationLabels = {
  pending: "授权进行中",
  missing: "未授权",
  valid: "已授权",
  refreshable: "已授权（访问凭据待刷新）",
  expired: "已过期",
  unavailable: "授权模块未启用",
} as const;

export function renderFeishuPermissionStatus(
  appId: string,
  status: FeishuPermissionRuntimeStatus,
  userAuthorization: FeishuUserAuthorizationStatus,
): string {
  return [
    "飞书 Surface 状态",
    `App ID：${appId}`,
    `长连接：${status.connectionReady ? "已就绪" : "未就绪"}`,
    `私聊消息事件：已验证（当前命令已收到）`,
    `卡片动作回调：${
      status.cardActionObserved
        ? "已验证（当前 Gateway 进程已收到）"
        : "尚未验证（当前 Gateway 进程未收到）"
    }`,
    `机器人菜单事件：${
      status.menuEventObserved
        ? "已验证（当前 Gateway 进程已收到）"
        : "尚未验证（当前 Gateway 进程未收到）"
    }`,
    `当前用户 OAuth：${userAuthorizationLabels[userAuthorization]}`,
    "",
    "运行状态来自当前 Gateway 的实际观测；OAuth 只读取安全凭据后端中的状态，不显示 Token。",
  ].join("\n");
}

export function renderFeishuDoctor(
  status: FeishuPermissionRuntimeStatus,
): string {
  return [
    status.connectionReady ? "✅ 长连接" : "❌ 长连接：未就绪",
    "✅ 消息接收",
    status.cardActionObserved
      ? "✅ 卡片交互"
      : "◯ 卡片交互：待使用验证",
    status.menuEventObserved
      ? "✅ 自定义菜单"
      : "◯ 自定义菜单：待点击验证",
  ].join("\n");
}

export function renderFeishuPermissionHelp(): string {
  return [
    "飞书权限中心",
    "/fs status · 查看当前运行观测",
    "/fs doctor · 检查必要能力并给出修复入口",
    "/fs revoke · 清除当前账号的本地授权",
    "用户权限会在使用相关飞书能力时按需申请。",
  ].join("\n");
}
