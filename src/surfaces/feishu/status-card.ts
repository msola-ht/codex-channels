import type { PlanPresentation } from "../plan-presentation.js";
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

export function renderFeishuPlanCard(
  presentation: PlanPresentation,
): FeishuCardDocument {
  const detail = presentation.text.split("\n").slice(1).join("\n").trim()
    || "暂无步骤";
  return {
    config: {
      update_multi: true,
      wide_screen_mode: true,
    },
    header: {
      template: presentation.title.startsWith("计划进度")
        ? "green"
        : "blue",
      title: {
        tag: "plain_text",
        content: presentation.title,
      },
    },
    elements: [{
      tag: "div",
      text: {
        tag: "plain_text",
        content: detail,
      },
    }],
  };
}
