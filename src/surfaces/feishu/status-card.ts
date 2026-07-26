import type { FeishuCardDocument } from "./approval-card.js";

export function renderFeishuThreadStatusCard(
  status: string,
): FeishuCardDocument {
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: status === "active"
        ? "blue"
        : status === "idle"
          ? "green"
          : "grey",
      title: {
        tag: "plain_text",
        content: "Thread 状态",
      },
    },
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: status === "active"
          ? "运行中"
          : status === "idle"
            ? "空闲"
            : "未知",
      },
    }],
  };
}
