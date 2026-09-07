import type { FeishuCardDocument } from "./approval-card.js";

export function renderFeishuConversationIdleReleasedCard(
  minutes: number,
  threadId: string,
): FeishuCardDocument {
  const command = `/r ${threadId}`;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: "grey",
      title: {
        tag: "plain_text",
        content: "会话已自动解除占用",
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: `会话已因 **${minutes}** 分钟无输入和输出自动解除占用。`,
        },
        {
          tag: "markdown",
          content: `**Session ID：** ${threadId}`,
        },
        {
          tag: "markdown",
          content: "恢复会话：",
        },
        {
          tag: "markdown",
          content: `\`${command}\``,
        },
        {
          tag: "markdown",
          content: "也可以直接发送消息开始新对话。",
        },
      ],
    },
  };
}
