import type { UserFacingError } from "../../conversation-core/index.js";

export function formatTelegramUserFacingError(error: UserFacingError): string {
  switch (error.code) {
    case "message.empty":
      return "消息不能为空";
    case "conversation.name.invalid":
      return "会话名称必须为 1–64 个字符";
    case "conversation.missing":
      return "当前还没有 Codex Thread";
    case "conversation.busy":
      return "当前任务运行中，请先使用 /stop 停止当前任务";
    case "image.path.invalid":
      return "本地图片路径必须是绝对路径";
    case "image.too-large":
      return "图片超过 10 MiB 限制";
    case "image.unsupported":
      return "仅支持 PNG 和 JPEG 图片";
    case "session.selector.required":
      return `用法：/${detail(error, "command", "resume")} <序号、名称或 Thread ID>`;
    case "session.selector.ambiguous":
      return "会话选择不唯一";
    case "session.selector.not-found":
      return "找不到指定会话";
    case "thread.bound":
      return "该 Codex Thread 已绑定到其他会话";
    case "goal.empty":
      return "目标不能为空";
    case "goal.usage":
      return "用法：/goal [set <目标>|clear]";
    case "workspace.missing":
      return `Workspace 不存在或未获授权：${detail(error, "workspaceId", "未知")}`;
    case "workspace.selector.required":
      return "用法：/workspace <序号、ID 或名称>";
    case "workspace.selector.ambiguous":
      return "Workspace 选择不唯一";
    case "workspace.selector.not-found":
      return "找不到指定 Workspace";
    case "model.current.missing":
      return `当前模型不在可用模型列表中：${detail(error, "model", "未知")}`;
    case "model.selector.required":
      return "用法：/model <序号、模型 ID 或名称>";
    case "model.selector.ambiguous":
      return "模型选择不唯一";
    case "model.selector.not-found":
      return "找不到指定模型";
    case "effort.unsupported": {
      const options = error.details.options;
      return `当前模型不支持该思考强度，可选：${Array.isArray(options) ? options.join("、") : "无"}`;
    }
    case "fast.usage":
      return "用法：/fast [on|off|status]";
    case "fast.unsupported":
      return `当前模型不支持 Fast 模式：${detail(error, "model", "未知")}`;
    case "command.unsupported":
      return `不支持的会话命令：${detail(error, "command", "未知")}`;
    case "review.usage":
      return "用法：/review [branch <分支>|commit <SHA>|custom <说明>]";
  }
}

function detail(error: UserFacingError, key: string, fallback: string): string {
  const value = error.details[key];
  return typeof value === "string" ? value : fallback;
}
