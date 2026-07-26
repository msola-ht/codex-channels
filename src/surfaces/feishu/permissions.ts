export interface FeishuPermissionRuntimeStatus {
  connectionReady: boolean;
  cardActionObserved: boolean;
}

const requiredTenantScope = "im:message:send_as_bot";
const requiredMessageEvent = "im.message.receive_v1";
const requiredCardCallback = "card.action.trigger";

export function renderFeishuPermissionStatus(
  appId: string,
  status: FeishuPermissionRuntimeStatus,
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
    "",
    "状态来自当前 Gateway 的实际运行观测，不读取或保存飞书用户 OAuth Token。",
  ].join("\n");
}

export function renderFeishuPermissionList(
  status: FeishuPermissionRuntimeStatus,
): string {
  return [
    "飞书权限中心",
    "",
    "当前 Gateway 使用的应用能力：",
    `1. 应用权限：${requiredTenantScope}`,
    "   状态：本条回复成功显示即表示当前可用",
    `2. 消息事件：${requiredMessageEvent}`,
    "   状态：已验证（当前命令已通过该事件送达）",
    `3. 卡片回调：${requiredCardCallback}`,
    `   状态：${
      status.cardActionObserved
        ? "已验证"
        : "尚未验证"
    }`,
    "",
    "用户授权：当前 Gateway 不读取或保存 User Access Token。",
    "后续飞书 CLI 按具体命令声明 Scope，并在私聊中增量申请，不在安装时默认申请全部权限。",
    "",
    "事件和回调配置后仍需在开放平台发布应用版本。",
    "申请或补充配置：/feishu apply",
  ].join("\n");
}

export function renderFeishuPermissionApplication(appId: string): string {
  const applicationUrl = `https://open.feishu.cn/app/${appId}`;
  const scopeUrl = `${applicationUrl}/auth?q=${
    encodeURIComponent(requiredTenantScope)
  }&op_from=codexc&token_type=tenant`;
  return [
    "飞书权限申请与配置",
    "",
    `[申请机器人发送消息权限](${scopeUrl})`,
    `[打开完整权限管理](${applicationUrl}/permission)`,
    `[打开当前飞书应用](${applicationUrl})`,
    "",
    "以上应用权限和配置操作需要 App Owner 或应用管理员完成。",
    `事件订阅：确认已添加 ${requiredMessageEvent}，并选择长连接。`,
    `回调订阅：确认已添加 ${requiredCardCallback}。`,
    "完成配置后发布应用版本，再发送 /feishu status 检查运行观测。",
    "",
    "应用权限可直接从上方链接申请，不需要重新扫码。事件和回调不是普通 Scope，需在应用配置中确认。",
    "完整权限管理页供后续飞书 CLI 按命令选择 Scope；此入口不会自动勾选或扩大权限。",
  ].join("\n");
}

export function renderFeishuPermissionHelp(): string {
  return [
    "飞书权限中心",
    "/feishu status · 查看当前运行观测",
    "/feishu permissions · 查看必需能力清单",
    "/feishu apply · 打开权限申请和应用配置",
  ].join("\n");
}
