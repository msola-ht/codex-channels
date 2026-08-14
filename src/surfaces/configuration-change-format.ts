import type {
  ConfigChange,
  ConfigChangeCode,
  ConfigChangeScope,
} from "../config/index.js";
import type { Workspace } from "../policy/index.js";
import { toStructuredMarkdownList } from "./conversation-command-format.js";
import type { SurfaceConfigurationChange } from "./types.js";

export function formatWorkspacesAdded(
  workspaces: readonly Workspace[],
  hasSwitchButtons = false,
): string {
  return toStructuredMarkdownList([
    workspaces.length === 1
      ? "Workspace 已添加"
      : `Workspace 已添加（${workspaces.length}）`,
    "",
    ...workspaces.flatMap((workspace) => [
      `${workspace.name} · ${workspace.id}`,
      `工作目录：${workspace.cwd}`,
      "",
    ]),
    hasSwitchButtons
      ? "点击下方按钮可直接切换；发送 /workspace 可查看全部 Workspace。"
      : "发送 /workspace 可查看并切换 Workspace。",
  ].join("\n"));
}

export function formatSurfaceConfigurationChange(
  change: SurfaceConfigurationChange,
  surface: Exclude<ConfigChangeScope, "global">,
  hasWorkspaceSwitchButtons = false,
): string {
  const changes = formatConfigChanges(change.changes, surface);
  switch (change.action) {
    case "reloaded":
      if (change.addedWorkspaces.length > 0) {
        return toStructuredMarkdownList([
          formatWorkspacesAdded(
            change.addedWorkspaces,
            hasWorkspaceSwitchButtons,
          ),
          "",
          `已生效：${changes}`,
        ].join("\n"));
      }
      return [
        toStructuredMarkdownList([
          "Gateway 配置已热加载",
          ...(changes ? [`已生效：${changes}`] : []),
        ].join("\n")),
      ].join("\n");
    case "restarting":
      return toStructuredMarkdownList([
        "Gateway 配置需要重启",
        ...(changes ? [`变更：${changes}`] : []),
        "当前 Gateway 将退出；若由系统服务托管，将自动重新启动。",
      ].join("\n"));
    case "reinstall-required":
      return toStructuredMarkdownList([
        "Gateway 配置尚未应用",
        ...(changes ? [`需要重装服务：${changes}`] : []),
        "请在本机执行：",
        "- codexc service install",
      ].join("\n"));
    case "reload-failed":
      return toStructuredMarkdownList([
        "Gateway 配置热加载失败",
        "当前有效配置继续运行。请检查配置后再次保存。",
      ].join("\n"));
  }
}

function formatConfigChanges(
  changes: readonly ConfigChange[],
  surface: Exclude<ConfigChangeScope, "global">,
): string {
  return changes.map((change) => {
    if (change.scope !== "global" && change.scope !== surface) {
      throw new Error(`${surface} 收到了其他 Surface 的配置变更`);
    }
    return configChangeLabel(change.code);
  }).join("、");
}

function configChangeLabel(code: ConfigChangeCode): string {
  const labels: Record<ConfigChangeCode, string> = {
    "codex.binary": "Codex Binary",
    "codex.socket": "Codex Socket",
    "codex.default-model": "默认模型",
    "codex.sandbox": "Sandbox",
    "network.proxy": "网络代理",
    "storage.database": "State Database",
    "approval.timeout": "审批超时",
    "display.operation-updates": "操作过程显示",
    "display.plan-updates": "自动计划显示",
    "display.price-currency": "价格显示币种",
    "experimental.plugin-api": "开发中 Plugin API",
    "thread-sections.administrators": "Thread 分区管理员",
    "api.providers": "第三方 API 提供商",
    "vision.provider": "视觉识别服务",
    "metrics.sync": "多设备指标同步",
    "metrics.storage": "指标保留策略",
    "observability.log-level": "日志级别",
    "workspace.default": "默认 Workspace",
    "workspace.registry": "Workspace",
    "surface.telegram.enabled": "Telegram 启用状态",
    "surface.telegram.token": "Telegram Bot Token",
    "surface.telegram.proxy": "Telegram 代理",
    "surface.telegram.message-format": "Telegram 消息格式",
    "surface.telegram.allowed-users": "Telegram 允许用户",
    "surface.feishu.enabled": "飞书启用状态",
    "surface.feishu.credentials": "飞书应用凭据",
    "surface.feishu.allowed-users": "飞书允许用户",
    "surface.weixin.enabled": "微信启用状态",
    "surface.weixin.account": "微信账号",
    "surface.weixin.allowed-users": "微信允许用户",
  };
  return labels[code];
}
