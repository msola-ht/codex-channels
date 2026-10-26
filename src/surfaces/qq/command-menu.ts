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
    content: "## Codex 命令中心\n\n常用操作直接点击；设置与管理功能按分类展开。",
    keyboard: { content: { rows: [
      { buttons: [button("new", "新会话", "/new"), button("status", "当前状态", "/status"), button("stop", "停止任务", "/stop")] },
      { buttons: [button("model", "选择模型", "/help model 1"), button("effort", "思考等级", "/effort"), button("fast", "速度", "/fast status")] },
      { buttons: [button("workspace", "工作区", "/help workspace 1"), button("sessions", "历史会话", "/help sessions 1"), button("usage", "用量", "/usage")] },
      { buttons: [button("metrics", "统计", "/help metrics"), button("manage", "会话操作", "/help manage"), button("settings", "偏好设置", "/help settings")] },
      { buttons: [button("extensions", "能力集成", "/help extensions"), button("tasks", "任务工具", "/help tasks"), button("account", "账户工具", "/help account")] },
    ] } },
  };
}
