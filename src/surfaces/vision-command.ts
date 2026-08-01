import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { SurfaceInputCoalescer } from "./surface-input-coalescer.js";

export function executeVisionCommand(
  inputs: Pick<SurfaceInputCoalescer, "cancelVisionPrompt" | "setVisionPrompt">,
  target: ConversationTarget,
  actorId: string,
  argumentsText: string,
): string {
  const value = argumentsText.trim();
  if (!value) {
    throw new UserFacingError(
      "vision.command.usage",
      "请使用 /vision <图片识别要求>，或发送 /vision cancel 取消",
    );
  }
  if (value.toLowerCase() === "cancel") {
    return inputs.cancelVisionPrompt(target, actorId)
      ? "已取消待处理的图片识别要求。"
      : "当前没有待处理的图片识别要求。";
  }
  const { replaced } = inputs.setVisionPrompt(target, actorId, value);
  return [
    replaced ? "已替换图片识别要求。" : "已记录图片识别要求。",
    "请在 5 分钟内发送图片；要求只用于下一批图片。",
    "取消：/vision cancel",
  ].join("\n");
}
