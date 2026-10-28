import { conversationMenuAction, type ConversationMenuActionId } from "../conversation-command-catalog.js";
import type { QqCommandKeyboard } from "./protocol.js";

export type QqMenuButton = QqCommandKeyboard["content"]["rows"][number]["buttons"][number];

export function qqChoiceLayout(labels: readonly string[]): { columns: number; pageSize: number } {
  const width = Math.max(0, ...labels.map(label => Array.from(label)
    .reduce((sum, character) => sum + (/^[\x20-\x7e]$/u.test(character) ? 1 : 2), 0)));
  const columns = width <= 10 ? 3 : width <= 18 ? 2 : 1;
  return { columns, pageSize: columns * 3 };
}

/** Expand long labels within five rows without merging semantic groups or dropping actions. */
export function layoutQqKeyboard(keyboard: QqCommandKeyboard): QqCommandKeyboard {
  // Leave invalid shapes intact for the protocol validator; layout must not repair them.
  if (!keyboard.content.rows.length || keyboard.content.rows.length > 5
    || keyboard.content.rows.some(row => !row.buttons.length || row.buttons.length > 5)) return keyboard;
  const groups = keyboard.content.rows.map(row => ({ buttons: row.buttons, count: 1 }));
  let spare = 5 - groups.length;
  while (spare > 0) {
    const candidate = groups.filter(group => Math.ceil(group.buttons.length / group.count)
      > qqChoiceLayout(group.buttons.map(button => button.render_data.label)).columns)
      .sort((a, b) => Math.ceil(b.buttons.length / b.count) - Math.ceil(a.buttons.length / a.count))[0];
    if (!candidate) break;
    candidate.count++;
    spare--;
  }
  return { content: { rows: groups.flatMap(group => {
    let offset = 0;
    return Array.from({ length: group.count }, (_, index) => {
      const size = Math.ceil((group.buttons.length - offset) / (group.count - index));
      const buttons = group.buttons.slice(offset, offset + size);
      offset += size;
      return { buttons };
    });
  }) } };
}

export function qqMenuButton(id: string, label: string, data: string, enter = true): QqMenuButton {
  return {
    id, render_data: { label, style: 0 },
    action: enter
      ? { type: 1, permission: { type: 2 }, data, unsupport_tips: "当前客户端不支持此按钮，请使用命令入口。" }
      : { type: 2, permission: { type: 2 }, data, enter: false, reply: false },
  };
}

/** Fixed navigation; selections are resolved by the account-owned menu controller. */
export function renderQqCommandMenu(): { content: string; keyboard: QqCommandKeyboard } {
  const button = qqMenuButton;
  return {
    content: "## Codex 命令中心\n\n### 常用操作\n\n- 当前状态、停止任务、新会话\n- 模型、思考等级与 Fast\n- 工作区、历史会话与账户用量\n\n### 分类入口\n\n- 请求统计、会话管理、会话偏好\n- 能力集成、任务工具、账户工具\n\n点击分类继续查看；填写类按钮会填入原命令，补齐内容后再发送。Fast 先查看当前速度设置。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("status"), commandButton("stop"), commandButton("new")] },
      { buttons: [button("model", "选择模型", "/help model 1"), commandButton("effort"), commandButton("fast-status", { id: "fast", label: "Fast" })] },
      { buttons: [button("workspace", "工作区", "/help workspace 1"), button("sessions", "历史会话", "/help sessions 1"), commandButton("usage", { label: "账户用量" })] },
      { buttons: [button("metrics", "请求统计", "/help metrics"), button("manage", "会话管理", "/help manage"), button("settings", "会话偏好", "/help settings")] },
      { buttons: [button("extensions", "能力集成", "/help extensions"), button("tasks", "任务工具", "/help tasks"), button("account", "账户工具", "/help account")] },
    ] } },
  };
}

function commandButton(actionId: ConversationMenuActionId, options: {
  id?: string;
  label?: string;
  argumentsText?: string;
  enter?: boolean;
} = {}): QqMenuButton {
  const action = conversationMenuAction(actionId);
  const argumentsText = options.argumentsText ?? action.argumentsText;
  const enter = options.enter ?? true;
  const data = `/${action.command}${argumentsText || !enter ? ` ${argumentsText}` : ""}`;
  return qqMenuButton(options.id ?? actionId, options.label ?? action.label, data, enter);
}

/** Static presentation only; command admission and live selection ownership remain in their existing handlers. */
export function renderQqStaticCommandMenu(input: string): { content: string; keyboard: QqCommandKeyboard } | undefined {
  if (!input) return renderQqCommandMenu();
  const homeButton = () => qqMenuButton("home", "首页", "/help");
  if (input === "schedule-create") return {
    content: "## 新增计划任务\n\n### 周期与填写参数\n\n1. 每隔：间隔、时区、任务\n2. 一次性：日期、时间、时区、任务\n3. 每月：日、时间、时区、任务\n4. 每天：时间、时区、任务\n5. 工作日：时间、时区、任务\n6. 每周：星期、时间、时区、任务\n\n### 格式说明\n\n- 时间：HH:mm；日期：YYYY-MM-DD\n- 间隔：如 30m；星期：如 MO,FR\n- 时区：明确填写，如 Asia/Shanghai\n\n点击类型后补齐参数并发送。创建前会展示工作区、提供商、模型等执行上下文预览，确认后才创建。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("schedule-add-interval", { id: "interval", enter: false }), commandButton("schedule-add-once", { id: "once", enter: false })] },
      { buttons: [commandButton("schedule-add-monthly", { id: "monthly", enter: false }), commandButton("schedule-add-daily", { id: "daily", enter: false })] },
      { buttons: [commandButton("schedule-add-weekdays", { id: "weekdays", enter: false }), commandButton("schedule-add-weekly", { id: "weekly", enter: false })] },
      { buttons: [commandButton("schedule", { id: "natural", label: "填写自然语言需求", enter: false }), commandButton("schedule", { label: "计划任务列表", argumentsText: "list" })] },
      { buttons: [homeButton()] },
    ] } },
  };
  if (input === "account") return {
    content: "## 账户工具\n\n### 查询与管理\n\n- 账户额度与重置券\n- 当前渠道身份\n\n点击下方操作；机器人接入与单聊允许名单请在本机 Setup 管理。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("limits", { label: "账户额度" }), commandButton("limits-reset", { id: "credits" })] },
      { buttons: [qqMenuButton("whoami", "我的身份", "/whoami")] },
      { buttons: [homeButton()] },
    ] } },
  };
  if (input === "extensions") return {
    content: "## 能力与集成\n\n### 任务能力\n\n- 子代理、Skills、Plugin：选择后填写任务\n\n### 集成管理\n\n- MCP：目录、健康、认证与重载\n- Hooks：查看配置并按预览确认\n\n点击下方入口继续。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("agents"), commandButton("skill"), commandButton("plugin")] },
      { buttons: [commandButton("mcp", { label: "MCP 列表" }), commandButton("mcp-health", { id: "mcphealth" }), commandButton("plugin-health", { id: "pluginhealth" })] },
      { buttons: [commandButton("hooks"), commandButton("mcp-reload", { id: "mcpreload" })] },
      { buttons: [homeButton()] },
    ] } },
  };
  if (input === "tasks") return {
    content: "## 任务工具\n\n### 任务操作\n\n- Diff：查看当前改动\n- Review：选择审查目标\n- 计划任务：查看与管理定时任务\n\n点击下方操作；计划需求需填写后发送。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("diff"), qqMenuButton("review", "Review", "/help review")] },
      { buttons: [commandButton("schedule")] },
      { buttons: [commandButton("plan-request", { id: "planrequest", enter: false })] },
      { buttons: [homeButton()] },
    ] } },
  };
  if (input === "review") return {
    content: "## Review\n\n### 审查目标\n\n1. 当前未提交改动\n2. 指定分支差异\n3. 指定提交\n4. 自定义审查要求\n\n当前改动可直接执行；其他目标需填写后发送。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("review", { label: "审查当前改动" }), commandButton("review-branch", { id: "reviewbranch", enter: false })] },
      { buttons: [commandButton("review-commit", { id: "reviewcommit", enter: false }), commandButton("review-custom", { id: "reviewcustom", enter: false })] },
      { buttons: [qqMenuButton("contents", "返回任务工具", "/help tasks"), homeButton()] },
    ] } },
  };
  if (input === "settings") return {
    content: "## 会话偏好\n\n### 当前会话设置\n\n- Plan：点击后切换协作模式\n- 会话审批方式：调整当前会话审批\n- 权限：只读查询\n\n点击下方选项继续。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("plan", { label: "切换 Plan 模式" })] },
      { buttons: [commandButton("autoreview", { label: "会话审批方式" }), commandButton("permissions")] },
      { buttons: [homeButton()] },
    ] } },
  };
  if (input === "manage") return {
    content: "## 会话管理\n\n### 当前会话\n\n- 归档、分叉、重命名\n- 固定、取消固定、释放占用\n- 历史回退、压缩上下文\n\n归档会退出当前会话；恢复入口位于“已归档会话”。",
    keyboard: { content: { rows: [
      { buttons: [commandButton("archive"), qqMenuButton("archived", "已归档会话", "/help archived 1")] },
      { buttons: [commandButton("fork"), commandButton("rename", { enter: false })] },
      { buttons: [commandButton("release"), commandButton("pin"), commandButton("unpin")] },
      { buttons: [commandButton("revert"), commandButton("compact")] },
      { buttons: [homeButton()] },
    ] } },
  };
  return undefined;
}
