import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { SurfaceInputCoalescer } from "./surface-input-coalescer.js";

export async function executeVisionCommand(
  inputs: Pick<
    SurfaceInputCoalescer,
    | "beginVisionCollection"
    | "cancelVisionPrompt"
    | "completeVisionCollection"
    | "setVisionPrompt"
  >,
  target: ConversationTarget,
  actorId: string,
  argumentsText: string,
): Promise<string> {
  const value = argumentsText.trim();
  if (!value) {
    throw new UserFacingError(
      "vision.command.usage",
      "请使用 /vision <要求>、/vision begin <要求>、/vision done 或 /vision cancel",
    );
  }
  const [operation = "", ...rest] = value.split(/\s+/u);
  const argumentsValue = rest.join(" ").trim();
  switch (operation.toLowerCase()) {
    case "cancel":
      if (argumentsValue) throw visionCommandUsageError();
      return inputs.cancelVisionPrompt(target, actorId)
        ? "已取消待处理的图片识别要求。"
        : "当前没有待处理的图片识别要求。";
    case "done": {
      if (argumentsValue) throw visionCommandUsageError();
      const result = await inputs.completeVisionCollection(target, actorId);
      return result.submission.steered
        ? `已将 ${result.imageCount} 张图片追加到当前 Turn。`
        : `已提交 ${result.imageCount} 张图片。`;
    }
    case "begin": {
      if (!argumentsValue) throw visionCommandUsageError();
      const { replacedPrompt } = inputs.beginVisionCollection(
        target,
        actorId,
        argumentsValue,
      );
      return [
        replacedPrompt ? "已将原图片识别要求改为多图收集。" : "已开始多图收集。",
        "请在 5 分钟内逐张发送最多 4 张图片。",
        "完成：/vision done；取消：/vision cancel",
      ].join("\n");
    }
  }
  const { replaced } = inputs.setVisionPrompt(target, actorId, value);
  return [
    replaced ? "已替换图片识别要求。" : "已记录图片识别要求。",
    "请在 5 分钟内发送图片；要求只用于下一批图片。",
    "取消：/vision cancel",
  ].join("\n");
}

export function formatVisionImagesCollected(
  imageCount: number,
  maximumImages: number,
): string {
  return [
    `已收集 ${imageCount}/${maximumImages} 张图片。`,
    "继续发送图片，完成：/vision done；取消：/vision cancel",
  ].join("\n");
}

function visionCommandUsageError(): UserFacingError {
  return new UserFacingError(
    "vision.command.usage",
    "请使用 /vision <要求>、/vision begin <要求>、/vision done 或 /vision cancel",
  );
}
