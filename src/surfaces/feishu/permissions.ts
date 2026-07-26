export interface FeishuPermissionRuntimeStatus {
  connectionReady: boolean;
  cardActionObserved: boolean;
}

type FeishuUserAuthorizationStatus =
  | "pending"
  | "missing"
  | "valid"
  | "refreshable"
  | "expired"
  | "unavailable";

const requiredTenantScope = "im:message:send_as_bot";
const oauthInspectionScope = "application:application:self_manage";
const requiredMessageEvent = "im.message.receive_v1";
const requiredCardCallback = "card.action.trigger";
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
    `当前用户 OAuth：${userAuthorizationLabels[userAuthorization]}`,
    "",
    "运行状态来自当前 Gateway 的实际观测；OAuth 只读取安全凭据后端中的状态，不显示 Token。",
  ].join("\n");
}

export function renderFeishuDoctor(
  appId: string,
  status: FeishuPermissionRuntimeStatus,
  userAuthorization: FeishuUserAuthorizationStatus,
): string {
  const applicationUrl = `https://open.feishu.cn/app/${appId}`;
  const messageScopeUrl = `${applicationUrl}/auth?q=${
    encodeURIComponent(requiredTenantScope)
  }&op_from=codexc&token_type=tenant`;
  const oauthInspectionScopeUrl = `${applicationUrl}/auth?q=${
    encodeURIComponent(oauthInspectionScope)
  }&op_from=codexc&token_type=tenant`;
  return [
    "飞书 Doctor",
    "",
    `长连接：${status.connectionReady ? "通过" : "未通过"}`,
    "私聊消息事件：通过（当前命令已收到）",
    `卡片动作回调：${status.cardActionObserved ? "通过" : "尚未验证"}`,
    `当前用户 OAuth：${userAuthorizationLabels[userAuthorization]}`,
    "",
    "当前 Surface 对话必需能力：",
    `- 应用权限：${requiredTenantScope}`,
    `- 消息事件：${requiredMessageEvent}`,
    `- 卡片回调：${requiredCardCallback}`,
    "",
    "当前 Surface 对话不依赖用户 OAuth；用户授权只供后续用户级飞书 API 使用。",
    `授权检测需要额外应用权限：${oauthInspectionScope}`,
    "/feishu authorize 会检测现有 Token，只增量申请尚未覆盖的应用用户权限。",
    "Token 只保存在 macOS Keychain 或 Linux 加密凭据文件，不进入会话数据库。",
    "",
    `[申请机器人发送消息权限](${messageScopeUrl})`,
    `[申请用户授权检测权限](${oauthInspectionScopeUrl})`,
    `[打开完整权限管理](${applicationUrl}/permission)`,
    `[打开当前飞书应用](${applicationUrl})`,
    "",
    "以上应用权限和配置操作需要 App Owner 或应用管理员完成。",
    `事件订阅：确认已添加 ${requiredMessageEvent}，并选择长连接。`,
    `回调订阅：确认已添加 ${requiredCardCallback}。`,
    "完成配置后发布应用版本，再发送 /feishu doctor 复查。",
    "",
    "应用权限可直接从上方链接申请，不需要重新扫码。事件和回调不是普通 Scope，需在应用配置中确认。",
  ].join("\n");
}

export function renderFeishuPermissionHelp(): string {
  return [
    "飞书权限中心",
    "/feishu status · 查看当前运行观测",
    "/feishu doctor · 检查必要能力并给出修复入口",
    "/feishu authorize · 在飞书内授权当前账号",
    "/feishu revoke · 清除当前账号的本地授权",
  ].join("\n");
}
