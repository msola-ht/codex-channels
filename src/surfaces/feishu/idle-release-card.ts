import type { FeishuCardDocument } from "./approval-card.js";
import { feishuCardButton, feishuCardColumnSetRow, feishuCardMarkdown, feishuCardShell } from "./card-kit.js";
import { formatConversationIdleReleased } from "../output-copy.js";

/** CardKit 创建失败时的降级 Markdown，与卡片一致地把恢复命令放入代码块。 */
export function formatFeishuConversationIdleReleased(
  minutes: number,
  threadId: string,
): string {
  return formatConversationIdleReleased(minutes, threadId, { fencedCommand: true });
}

export function renderFeishuConversationIdleReleasedCard(
  minutes: number,
  threadId: string,
  commandToken?: string,
): FeishuCardDocument {
  const command = `/r ${threadId}`;
  return feishuCardShell("grey", "会话已自动解除占用", [
    feishuCardMarkdown(`会话已因 **${minutes}** 分钟无输入和输出自动解除占用。`),
    feishuCardMarkdown(`**Session ID：** ${threadId}`),
    feishuCardMarkdown("恢复会话："),
    feishuCardMarkdown(["```", command, "```"].join("\n")),
    ...(commandToken === undefined ? [] : [feishuCardColumnSetRow([
      feishuCardButton("恢复此会话", "primary", {
        codexc_command_token: commandToken,
        codexc_command: "resume",
        codexc_command_input: threadId,
      }),
    ])]),
    feishuCardMarkdown("也可以直接发送消息开始新对话。"),
  ]);
}
