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
    case "image.path.invalid":
      return "本地图片路径必须是绝对路径";
    case "image.too-large":
      return error.details.scope === "batch"
        ? "图片总大小超过 20 MiB 限制"
        : "图片超过 10 MiB 限制";
    case "image.too-many":
      return "一次最多处理 4 张图片";
    case "image.unsupported":
      return "仅支持 PNG 和 JPEG 图片";
    case "vision.busy":
      return "视觉识别任务繁忙，请稍后重试";
    case "vision.failed":
      return "图片识别失败，请稍后重试或切换支持图片的模型";
    case "vision.command.usage":
      return "用法：/vision <要求>；多图：/vision <2–4> <要求>；取消：/vision cancel";
    case "vision.prompt.invalid":
      return "图片识别要求必须为 1 至 4000 个字符";
    case "vision.prompt.capacity":
      return "待处理的图片识别要求已满，请稍后重试";
    case "vision.collection.active":
      return "当前正在收集多张图片，请先使用 /vision done 完成或 /vision cancel 取消";
    case "vision.collection.missing":
      return "当前没有进行中的多图收集，请先使用 /vision begin <要求>";
    case "vision.collection.empty":
      return "请先发送至少一张图片，再使用 /vision done";
    case "vision.collection.count.invalid":
      return `多图数量必须为 2 至 ${detail(error, "maximumImages", "4")}`;
    case "vision.collection.count.exceeded":
      return `本次只需 ${detail(error, "expectedImages", "指定数量")} 张图片`;
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
      return "用法：/queue <描述>";
    case "queue.inactive":
      return "当前没有运行中的任务，请直接发送普通消息";
    case "queue.full":
      return "下一 Turn 队列已满，最多 10 条";
    case "queue.thread-changed":
      return "排队消息所属会话已切换，队列已清空";
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
      return `当前模型不支持该思考强度，可选：${Array.isArray(options) ? options.join("、") : "无"}`;
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
