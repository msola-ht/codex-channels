import type { ConversationStatus } from "../../application/index.js";
import type { OutputEvent } from "../../conversation-core/index.js";
import {
  createStartupPresentation, createTurnCompletedPresentation,
  renderPlainLifecyclePresentation, type StartupRuntimeInfo,
} from "../lifecycle-presentation.js";

export function renderQqStartupNotification(
  workspaces: ReadonlyArray<{ id: string; name: string; cwd: string }>,
  status: ConversationStatus,
  runtime: StartupRuntimeInfo,
): string {
  return `${renderPlainLifecyclePresentation(createStartupPresentation(workspaces, status, runtime))}\n\nQQ 文字渠道已就绪。使用 /help 查看命令；不会补发重启前的任务结果。`;
}

export function renderQqTurnCompleted(
  event: Extract<OutputEvent, { type: "turn.completed" }>,
  autoCompactPercent?: (provider: string | null | undefined, model: string | null | undefined) => number | null,
): string {
  return `${renderPlainLifecyclePresentation(createTurnCompletedPresentation(event, false, autoCompactPercent))}\n\n正文送达情况以各条结果为准；缺失结果请核对本机投递箱。${event.status === "failed" ? "QQ 暂不支持审批或问题回应。" : ""}`;
}
