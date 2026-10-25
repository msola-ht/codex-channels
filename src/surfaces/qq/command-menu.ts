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
    content: "# Codex",
    keyboard: { content: { rows: [
      { buttons: [button("status", "当前状态", "/status"), button("sessions", "历史会话", "/help sessions 1"), button("new", "新建会话", "/new")] },
      { buttons: [button("workspace", "选择工作区", "/help workspace 1"), button("model", "选择模型", "/help model 1"), button("stop", "停止任务", "/stop")] },
      { buttons: [button("usage", "用量", "/usage"), button("limits", "额度", "/limits"), button("metrics", "请求统计", "/help metrics")] },
      { buttons: [button("diff", "查看改动", "/diff"), button("manage", "会话管理", "/help manage")] },
    ] } },
  };
}
