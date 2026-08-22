import {
  archivedSessionCommandUsageText,
  mcpCommandUsageText,
  pluginCommandUsageText,
  sessionCommandUsageText,
  threadQueueCommandUsageText,
} from "../application/index.js";
import type { UserFacingError } from "../conversation-core/index.js";
import { gatewayRequestFailedText } from "./output-copy.js";

export function formatSurfaceUserFacingError(
  error: UserFacingError,
  surfaceLabel: "Telegram" | "飞书" | "微信",
): string {
  switch (error.code) {
    case "message.empty":
      return "消息不能为空";
    case "conversation.name.invalid":
      return "会话名称必须为 1–64 个字符";
    case "conversation.missing":
      return "当前还没有 Codex Thread";
    case "conversation.busy":
      return "当前任务运行中，请先使用 /stop 停止当前任务";
    case "conversation.background-limit":
      return error.message;
    case "conversation.background-queued":
      return "当前任务仍有下一 Turn 排队消息，暂不能切换会话";
    case "image.url.invalid":
      return "图片必须使用 PNG 或 JPEG Base64 Data URL";
    case "image.too-large":
      return error.details.scope === "batch"
        ? "图片总大小超过 20 MiB 限制"
        : "图片超过 10 MiB 限制";
    case "image.too-many":
      return "一次最多处理 4 张图片";
    case "image.unsupported":
      return "仅支持 PNG 和 JPEG 图片";
    case "audio.path.invalid":
      return "本地音频路径必须是绝对路径";
    case "audio.duration-missing":
      return "无法确认音频时长，请重新发送";
    case "audio.too-large":
      return "音频超过 20 MiB 限制";
    case "audio.unsupported":
      return "仅支持 WAV、MP3、M4A、WebM 和 OGG 音频";
    case "model.input.audio.unsupported":
      return `当前模型 ${detail(error, "model", "未知")} 不支持语音输入，请发送文字或图片`;
    case "model.input.image.unsupported":
      return `当前模型 ${detail(error, "model", "未知")} 不支持图片输入，请发送文字或切换支持图片的模型`;
    case "model.input.unsupported":
      return `当前模型 ${detail(error, "model", "未知")} 不支持该输入类型`;
    case "session.selector.required":
      return `用法：/${detail(error, "command", "resume")} <序号、名称或 Thread ID>`;
    case "session.selector.ambiguous":
      return "会话选择不唯一";
    case "session.selector.not-found":
      return "找不到指定会话";
    case "sessions.usage":
      return sessionCommandUsageText;
    case "archived-sessions.usage":
      return archivedSessionCommandUsageText;
    case "thread-section.usage":
      return "用法：/section [list [页码]|create <名称>|rename <分区 ID 或序号> <新名称>|move <分区 ID 或序号> [before <会话>]|remove|delete <分区 ID 或序号> [confirm]]";
    case "thread-section.name.invalid":
      return "Thread 分区名称必须为 1–64 个字符，且不能包含控制字符";
    case "thread-section.selector.ambiguous":
      return "Thread 分区选择不唯一，请使用完整 ID";
    case "thread-section.selector.not-found":
      return "找不到指定 Thread 分区";
    case "thread-section.pinned.immutable":
      return "内置固定区不能重命名或删除；请使用 /pin 或 /unpin 管理固定状态";
    case "thread-section.before.invalid":
      return "before 指定的会话必须已经位于目标分区";
    case "thread-section.delete-confirmation.invalid":
      return "删除确认必须使用预览返回的完整 Thread 分区 ID";
    case "thread-section.admin-required":
      return "当前用户没有 Thread 分区写权限；请在 thread_sections.administrators 中配置对应渠道用户 ID，并重启 Gateway";
    case "thread.bound":
      return "该 Codex Thread 已绑定到其他会话";
    case "thread.takeover.busy":
      return "原渠道或当前渠道仍有任务或待处理交互，暂不能接管";
    case "thread.takeover.workspace":
      return "只能接管当前 Workspace 中的 Codex Thread";
    case "thread.takeover.changed":
      return "会话绑定刚刚发生变化，请重新打开会话列表后再试";
    case "goal.empty":
      return "目标不能为空";
    case "goal.usage":
      return "用法：/goal [set <目标>|clear]";
    case "queue.usage":
      return threadQueueCommandUsageText;
    case "metrics.usage":
      return "用法：/metrics [session|global|providers|models|errors] [24h|7d|30d]";
    case "queue.full":
      return "App Server Queue 已满，最多 100 条";
    case "queue.unavailable":
      return "当前 App Server 不提供持久队列";
    case "queue.empty":
      return "App Server Queue 为空，请先使用 /queue add 新增条目";
    case "queue.busy":
      return "当前 Thread 有活动或待触发 Turn，请稍后重试";
    case "queue.pending-overrides":
      return "Queue 与待生效的模型、思考、Fast 或 Plan 选择不能同时存在；请先让其中一方处理完成";
    case "queue.snapshot.required":
      return "数字选择器只对最近五分钟的本会话 Queue 列表有效，请先执行 /queue list";
    case "queue.item-not-found":
      return "找不到指定 Queue 条目，请使用完整 ID 或刷新 /queue list";
    case "queue.item-not-editable":
      return "只有纯文本 Queue 条目可以更新；非纯文本输入可删除、排序或启动，但不能更新";
    case "queue.position.invalid":
      return "Queue 目标位置必须在当前队列范围内";
    case "queue.reorder-conflict":
      return "Queue 已发生变化，请刷新 /queue list 后重试排序";
    case "queue.failed":
      return "Queue 操作失败，请稍后重试";
    case "workspace.missing":
      return `Workspace 不存在或未获授权：${detail(error, "workspaceId", "未知")}`;
    case "workspace.selector.required":
      return "用法：/workspace <序号、ID 或名称>";
    case "workspace.selector.ambiguous":
      return "Workspace 选择不唯一";
    case "workspace.selector.not-found":
      return "找不到指定 Workspace";
    case "workspace.permission.usage":
      return "用法：/workspaceperm [sandbox <read-only|workspace-write|danger-full-access|clear>|approval <untrusted|on-request|never|clear>|profile <Profile ID|clear>]";
    case "workspace.permission.conflict":
      return "permissions 与 sandbox 互斥，不能同时配置；请先清除其中一项";
    case "workspace.permission.unavailable":
      return "当前 Gateway 不支持修改工作区权限";
    case "model.current.missing":
      return `当前模型不在可用模型列表中：${detail(error, "model", "未知")}`;
    case "model.unavailable":
      return `${detail(error, "model", "该模型")} 暂不可用：${detail(error, "reason", "上游暂未开放")}`;
    case "model.selector.required":
      return "用法：/model <序号、模型 ID 或名称>";
    case "model.selector.ambiguous":
      return "模型选择不唯一";
    case "model.selector.not-found":
      return "找不到指定模型";
    case "effort.unsupported": {
      const options = error.details.options;
      return `当前模型不支持该思考等级，可选：${Array.isArray(options) ? options.join("、") : "无"}`;
    }
    case "fast.usage":
      return "用法：/fast [on|off|status]";
    case "fast.unsupported":
      return `当前模型不支持 Fast 模式：${detail(error, "model", "未知")}`;
    case "provider.account.unavailable":
      return `${detail(error, "provider", "当前提供商")}的账户查询失败，请检查配置或稍后重试`;
    case "collaboration-mode.unsupported":
      return "当前 Codex App Server 不支持该协作模式";
    case "collaboration-mode.unavailable":
      return "Plan 模式服务不可用";
    case "plan.prompt.empty":
      return "Plan 需求不能为空";
    case "skill.usage":
      return "用法：/skill <名称或序号> <任务>";
    case "skill.not-found":
      return "指定的 Skill 不存在、未启用或不属于当前 Workspace";
    case "mcp.usage":
      return mcpCommandUsageText;
    case "mcp.server.usage":
      return "需要提供 MCP Server 名称或序号";
    case "mcp.server.not-found":
      return "指定的 MCP Server 不存在";
    case "mcp.oauth.unsupported":
      return "该 MCP Server 不支持 OAuth 登录";
    case "mcp.thread.required":
      return "请先发送消息创建 Thread，或使用 /resume 恢复 Thread 后再登录 MCP Server";
    case "mcp.resource.usage":
      return "需要提供有效的 MCP Resource URI";
    case "plugin.usage":
      return pluginCommandUsageText;
    case "plugin.not-found":
      return "指定的 Plugin 不存在";
    case "plugin.ambiguous":
      return "Plugin 名称不唯一，请使用序号或完整 ID";
    case "plugin.unavailable":
      return "指定的 Plugin 未启用、被管理员禁用或暂不可调用";
    case "plugin.disabled":
      return "开发中的 Plugin API 已关闭；请在 [experimental] 中启用 plugin_api 后重启 Gateway";
    case "plugin.provider.unsupported":
      return "开发中的 Plugin 调用当前只支持 OpenAI Thread";
    case "command.unsupported":
      return surfaceLabel === "Telegram"
        ? `不支持的会话命令：${detail(error, "command", "未知")}`
        : `不支持该${surfaceLabel}命令，请发送 /help 查看可用命令`;
    case "review.usage":
      return "用法：/review [branch <分支>|commit <SHA>|custom <说明>]";
    case "rules.usage":
      return "用法：/rules <init|check>";
    case "rules.exists":
      return `当前 Workspace 已有项目规则；${surfaceLabel}${surfaceLabel === "Telegram" ? " " : ""}不提供强制覆盖，请在终端中处理`;
    case "rules.missing":
      return "当前 Workspace 尚未生成项目规则，请先使用 /rules init";
    case "rules.unsafe-path":
      return "项目规则路径包含符号链接，已拒绝写入";
    case "rules.check-failed":
      return "项目规则检查失败，请在终端运行 codexc rules check 查看详情";
    case "rules.unavailable":
      return "项目规则服务当前不可用";
    default:
      return gatewayRequestFailedText;
  }
}

function detail(
  error: UserFacingError,
  key: string,
  fallback: string,
): string {
  const value = error.details[key];
  return typeof value === "string" ? value : fallback;
}
