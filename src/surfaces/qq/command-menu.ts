import type { QqCommandKeyboard } from "./protocol.js";

export type QqMenuButton = QqCommandKeyboard["content"]["rows"][number]["buttons"][number];

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
    content: "# Codex 命令中心\n常用操作直接点击；设置与管理功能按分类展开。",
    keyboard: { content: { rows: [
      { buttons: [button("new", "新会话", "/new"), button("status", "当前状态", "/status"), button("stop", "停止任务", "/stop")] },
      { buttons: [button("model", "选择模型", "/help model 1"), button("workspace", "工作区", "/help workspace 1"), button("sessions", "历史会话", "/help sessions 1")] },
      { buttons: [button("usage", "用量", "/usage"), button("limits", "额度", "/limits"), button("metrics", "统计", "/help metrics")] },
      { buttons: [button("manage", "会话操作", "/help manage"), button("settings", "偏好设置", "/help settings")] },
      { buttons: [button("extensions", "能力集成", "/help extensions"), button("tasks", "任务工具", "/help tasks"), button("account", "账户工具", "/help account")] },
    ] } },
  };
}
