import {
  archivedSessionCommandUsageText,
  resetCreditCommandUsage,
  mcpCommandUsageText,
  pluginCommandUsageText,
  sessionCommandUsageText,
  scheduledTaskCommandUsageText,
  threadQueueCommandUsageText,
  threadRevertCommandUsageText,
} from "../application/index.js";
import type { UserFacingError } from "../conversation-core/index.js";
import { gatewayRequestFailedText } from "./output-copy.js";
import { formatReasoningEffort } from "./reasoning-effort-format.js";

export function formatSurfaceUserFacingError(
  error: UserFacingError,
  surfaceLabel: "Telegram" | "飞书" | "微信",
): string {
  switch (error.code) {
    case "hooks.usage":
      return "用法：/hooks [page N|列表选择标识|trust <标识>|enable <标识>|disable <标识>|confirm <一次性令牌>]";
    case "hooks.actor-required":
    case "hooks.forbidden":
      return "当前用户身份或工作区授权无法确认，已拒绝 Hook 操作";
    case "hooks.provider-required":
      return "当前未确定模型提供商，请先通过 /model 选择提供商";
    case "hooks.page-invalid":
      return "Hook 页码无效，请发送 /hooks 返回列表";
    case "hooks.managed":
      return "受管理员管理的 Hook 只读，不能在渠道中信任或启停";
    case "hooks.local-review-required":
      return "该 Hook 无法在渠道中完整审查，请先在本机核对配置";
    case "hooks.review-expired":
      return "Hook 选择、确认或配置已变化或失效，请重新发送 /hooks 并审查详情";
    case "hooks.read-failed":
    case "hooks.version-unavailable":
      return "当前 Hook 配置无法安全读取，请在本机核对配置后重新发送 /hooks";
    case "hooks.write-unconfirmed":
      return "Hook 修改结果尚未确认，请先用 /hooks 核对状态，避免重复提交";
    case "hooks.readback-failed":
    case "hooks.state-unconfirmed":
      return "Hook 修改后未能确认实际状态，请使用 /hooks 或在本机核对配置";
    case "reset-credit.failed":
      switch (error.details.reason) {
        case "usage": return resetCreditCommandUsage;
        case "forbidden": return "当前用户没有操作该账户重置券的授权";
        case "reset_stale": return "用户、会话、工作区、账户、券状态或确认已变化，请重新使用 /limits reset 查询";
        case "reset_busy": return "已有重置操作正在处理或确认数量已达上限，请稍后查询";
        case "reset_unknown": return "消费结果待确认，请使用 /limits reset 核对官方状态，不要直接重复消费";
        default: return "重置券暂不可用，请检查 ChatGPT 登录状态并稍后查询";
      }
    case "attachment.too-many":
      return "一次最多处理 4 个文本附件";
    case "attachment.too-large":
      return "文本附件总大小超过 1,000,000 字节限制";
    case "attachment.unsupported":
      return "文本附件格式不支持";
    case "attachment.capacity":
      return "文本附件暂存空间已满，请稍后重试或发送较小片段";
    case "message.empty":
      return "消息不能为空";
    case "conversation.name.invalid":
      return "会话名称必须为 1–64 个字符";
    case "conversation.missing":
      return "当前还没有 Codex Session";
    case "conversation.busy":
      if (error.details.reason === "pending-interaction") return "当前会话有待处理交互，请先完成或取消后再切换审批方式";
      return "当前任务运行中，请先使用 /stop 停止当前任务";
    case "delivery.overloaded":
      if (error.details.reason === "global-capacity") return "投递箱全局容量达到暂停阈值，暂不能保存更多执行结果；请使用 codexc delivery status 核对占用并处理积压";
      if (error.details.reason === "account-capacity") return "当前渠道账号的投递容量达到暂停阈值，暂不能保存更多执行结果；请使用 codexc delivery status 核对占用并处理积压";
      return "投递存储尚未就绪、不可用或正在关闭，已暂停新执行；请检查 Gateway 状态和投递错误日志";
    case "conversation.background-limit":
      return error.message;
    case "conversation.background-queued":
      return "当前任务仍有下一 Turn 排队消息，暂不能切换会话";
    case "image.reference.failed":
      return error.message;
    case "image.url.invalid":
      return "图片必须使用 PNG、JPEG、WebP 或非动画 GIF Base64 Data URL";
    case "image.too-large":
      return error.details.scope === "batch"
        ? "图片总大小超过 20 MiB 限制"
        : "图片超过 10 MiB 限制";
    case "image.too-many":
      return "一次最多处理 4 张图片";
    case "image.unsupported":
      return "仅支持 PNG、JPEG、WebP 和非动画 GIF 图片";
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
      return `用法：/${detail(error, "command", "resume")} <序号、名称或 Session ID>`;
    case "session.selector.ambiguous":
      return "会话选择不唯一";
    case "session.selector.not-found":
      return "在当前工作区找不到指定会话；跨工作区恢复不受支持，请先使用 /work 切换到会话所属工作区";
    case "sessions.usage":
      return sessionCommandUsageText;
    case "archived-sessions.usage":
      return archivedSessionCommandUsageText;
    case "thread.bound":
      return "该 Codex Session 已绑定到其他会话";
    case "thread.takeover.busy":
      return "原渠道或当前渠道仍有任务或待处理交互，暂不能接管";
    case "thread.takeover.workspace":
      return "只能恢复或接管当前工作区中的会话，请先使用 /work 切换到会话所属工作区";
    case "thread.takeover.changed":
      return "会话绑定或工作区已发生变化，请重新打开会话列表后再试";
    case "goal.empty":
      return "目标不能为空";
    case "goal.usage":
      return "用法：/goal [set <目标>|clear]";
    case "release.usage":
      return "用法：/release [force]";
    case "release.unsupported":
      return "当前环境不支持释放会话占用";
    case "scheduled-task.command.invalid":
      return error.message.includes("用法") ? scheduledTaskCommandUsageText : error.message;
    case "scheduled-task.confirmation.invalid":
    case "scheduled-task.forbidden":
    case "scheduled-task.not-found":
    case "scheduled-task.snapshot.required":
    case "scheduled-task.state.invalid":
      return error.message;
    case "queue.usage":
      return threadQueueCommandUsageText;
    case "metrics.usage":
      return "用法：/metrics [session|global|providers|models|errors] [24h|7d|30d|90d|all]";
    case "queue.full":
      return "App Server Queue 已满，最多 100 条";
    case "queue.unavailable":
      return "当前 App Server 不提供持久队列";
    case "queue.empty":
      return "App Server Queue 为空，请先使用 /queue add 新增条目";
    case "queue.busy":
      return "当前 Session 有活动或待触发 Turn，请稍后重试";
    case "queue.pending-overrides":
      return "Queue 与待生效的模型、思考、速度或 Plan 选择不能同时存在；请先让其中一方处理完成";
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
    case "revert.usage":
      return threadRevertCommandUsageText;
    case "revert.unavailable":
      return "当前 App Server 不支持分页历史回退";
    case "revert.empty-history":
      return "当前 Session 还没有可回退的 Turn";
    case "revert.legacy-thread":
      return "当前 Session 不支持回退；请新建分页历史会话";
    case "revert.snapshot-required":
      return "Turn 选择器只对最近五分钟的 /revert list 页面有效，请先重新列出历史";
    case "revert.turn-not-found":
      return "找不到指定 Turn，Revert 未执行";
    case "revert.confirmation-invalid":
      return "Revert 确认已失效，请重新生成预览";
    case "revert.concurrent":
      return "Session 历史、活动任务或 Queue 已发生变化，请重新生成 Revert 预览";
    case "revert.queue-unknown":
      return "无法确认当前 Queue，Revert 已失败关闭";
    case "revert.result-unknown":
      return "Revert 结果未知；请求不会自动重试，请重新执行 /revert list 核对历史";
    case "workspace.missing":
      return `Workspace 不存在或未获授权：${detail(error, "workspaceId", "未知")}`;
    case "workspace.selector.required":
      return "用法：/workspace <序号、ID 或名称>";
    case "workspace.selector.ambiguous":
      return "Workspace 选择不唯一";
    case "workspace.selector.not-found":
      return "找不到指定 Workspace";
    case "workspace.permission.usage":
      return error.details.reason === "stale-selection"
        ? "工作区审批按钮已失效或工作区已变化，请重新发送 /workspaceperm"
        : "用法：/workspaceperm [sandbox <read-only|workspace-write|danger-full-access|clear>|approval <untrusted|on-request|never|clear>|autoreview <on|off|clear>|profile <Profile ID|clear>]";
    case "workspace.permission.conflict":
      return "permissions 与 sandbox 互斥，不能同时配置；请先清除其中一项";
    case "autoreview.usage":
      return "用法：/autoreview [on|off]；只切换当前会话后续轮次的审批方式";
    case "autoreview.unavailable":
      return "当前会话无法切换审批方式；请先用 /autoreview 核对 App Server 的实际状态";
    case "autoreview.stale-selection":
      return "当前会话审批按钮已失效或会话已变化，请重新发送 /autoreview";
    case "autoreview.update-failed":
      return "当前会话审批方式更新请求未成功；请用 /autoreview 核对实际状态后再决定是否重试";
    case "autoreview.update-unconfirmed":
      return "尚未确认当前会话审批方式更新结果；请求不会自动重试，请用 /autoreview 核对实际状态";
    case "workspace.permission.unavailable":
      return "当前 Gateway 不支持修改工作区权限";
    case "model.current.missing":
      return `当前模型不在可用模型列表中：${detail(error, "model", "未知")}`;
    case "model.configured-default.missing":
      return `配置的默认模型不属于当前主 Provider ${detail(error, "provider", "未知")}：${detail(error, "model", "未知")}`;
    case "model.official.not-logged-in":
      return "OpenAI 官方未登录，当前没有可用模型；请先运行 codex login";
    case "model.provider.selection-required":
      return "OpenAI 官方未登录，已配置多个第三方提供商；请先通过 /model 选择提供商和模型";
    case "model.provider.default-missing":
      return `提供商 ${detail(error, "provider", "未知")} 的默认模型未配置，请通过 codexc setup 设置`;
    case "model.provider.mismatch":
      return error.message;
    case "model.unavailable":
      return `${detail(error, "model", "该模型")} 暂不可用：${detail(error, "reason", "上游暂未开放")}`;
    case "model.selector.required":
      return "用法：/model <提供商序号>，再用 /model <模型序号>";
    case "model.selector.ambiguous":
      return "模型选择不唯一";
    case "model.selector.not-found":
      return "找不到指定模型";
    case "model.provider.not-found":
      return `找不到指定提供商：${detail(error, "provider", "未知")}`;
    case "model.provider.no-models":
      return `提供商 ${detail(error, "provider", "未知")} 下没有可用模型`;
    case "model.selection.expired":
      return "模型已变化，请重新发送 /model 选择";
    case "effort.unsupported": {
      const options = error.details.options;
      const choices = Array.isArray(options)
        ? options.map((option: unknown) => typeof option === "string" ? formatReasoningEffort(option) : option).join("、")
        : "无";
      return `当前模型不支持该思考设置，可选：${choices}`;
    }
    case "fast.usage":
      return "用法：/fast [on|ultrafast|off|status]";
    case "fast.unsupported":
      return `当前模型不支持 ${error.details.tier === "Ultrafast" ? "Ultrafast" : "Fast"} 档位：${detail(error, "model", "未知")}`;
    case "fast.disabled":
      return "Codex features.fast_mode 已关闭，不能启用 Fast/Ultrafast；仍可用 /fast off 回到 Standard";
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
      return "请先发送消息创建 Session，或使用 /resume 恢复 Session 后再登录 MCP Server";
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
      return "开发中的 Plugin 调用当前只支持 OpenAI Session";
    case "agents.usage":
      return "用法：/agents <角色名称或序号> <任务>";
    case "agents.not-found":
      return "指定的子代理角色不存在；使用 /agents 查看可用角色";
    case "agents.config-unreadable":
      return "Codex 子代理角色配置无法安全读取；请检查 ~/.codex/config.toml";
    case "command.unsupported":
      return surfaceLabel === "Telegram"
        ? `不支持的会话命令：${detail(error, "command", "未知")}`
        : `不支持该${surfaceLabel}命令，请发送 /help 查看可用命令`;
    case "review.usage":
      return "用法：/review [branch <分支>|commit <SHA>|custom <说明>]";
    default: {
      const unhandledCode: never = error.code;
      void unhandledCode;
      return gatewayRequestFailedText;
    }
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
