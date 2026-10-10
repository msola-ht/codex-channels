import type { TurnStartIdentity } from "../../conversation-core/index.js";
import { formatTurnStartIdentityLabel } from "../lifecycle-presentation.js";
import type { PlanPresentation } from "../plan-presentation.js";
import type { FeishuCardDocument } from "./approval-card.js";
import { feishuCardPlainText, feishuCardShell } from "./card-kit.js";

export function renderFeishuThreadStatusCard(
  status: string,
  identity?: TurnStartIdentity,
): FeishuCardDocument {
  const identityPrefix = identity
    ? `${formatTurnStartIdentityLabel(identity)} · `
    : "";
  return feishuCardShell(
    status === "active"
      ? "blue"
      : status === "idle"
        ? "green"
        : "grey",
    "Session 状态",
    [feishuCardPlainText(
      status === "active"
        ? `${identityPrefix}运行中`
        : status === "idle"
          ? `${identityPrefix}处理结束 · 结果见下方消息`
          : "未知",
    )],
  );
}

export function renderFeishuPlanCard(
  presentation: PlanPresentation,
): FeishuCardDocument {
  const detail = presentation.text.split("\n").slice(1).join("\n").trim()
    || "暂无步骤";
  return feishuCardShell(
    presentation.title.startsWith("计划进度") ? "green" : "blue",
    presentation.title,
    [feishuCardPlainText(detail)],
  );
}
