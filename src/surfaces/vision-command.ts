import {
  UserFacingError,
  type ConversationTarget,
} from "../conversation-core/index.js";
import type { SurfaceInputCoalescer } from "./surface-input-coalescer.js";

export interface VisionCommandTiming {
  createdAtMs?: number;
  receivedAtMs: number;
  respondedAtMs: number;
}

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
      "请使用 /vision <要求>、/vision <2–4> <要求> 或 /vision cancel",
    );
  }
  const [operation = "", ...rest] = value.split(/\s+/u);
  const argumentsValue = rest.join(" ").trim();
  if (/^\d+$/u.test(operation)) {
    if (!argumentsValue) throw visionCommandUsageError();
    const expectedImages = Number(operation);
    const { replacedPrompt } = inputs.beginVisionCollection(
      target,
      actorId,
      argumentsValue,
      expectedImages,
    );
    return [
      replacedPrompt ? "图片收集要求已更新" : "图片收集已开始",
      `- 目标：${expectedImages} 张图片`,
      "- 时限：5 分钟",
      "- 提交：收齐后自动提交",
      "- 取消：/vision cancel",
    ].join("\n");
  }
  switch (operation.toLowerCase()) {
    case "cancel":
      if (argumentsValue) throw visionCommandUsageError();
      return inputs.cancelVisionPrompt(target, actorId)
        ? "已取消待处理的图片识别要求。"
        : "当前没有待处理的图片识别要求。";
    case "done": {
      if (argumentsValue) throw visionCommandUsageError();
      const result = await inputs.completeVisionCollection(target, actorId);
      return [
        "图片已提交",
        `- 数量：${result.imageCount} 张`,
        `- 状态：${result.submission.steered ? "已追加到当前 Turn" : "已进入处理队列"}`,
      ].join("\n");
    }
    case "begin": {
      if (!argumentsValue) throw visionCommandUsageError();
      const { replacedPrompt } = inputs.beginVisionCollection(
        target,
        actorId,
        argumentsValue,
      );
      return [
        replacedPrompt ? "图片收集要求已更新" : "图片收集已开始",
        "- 上限：4 张图片",
        "- 时限：5 分钟",
        "- 提交：/vision done",
        "- 取消：/vision cancel",
      ].join("\n");
    }
  }
  const { replaced } = inputs.setVisionPrompt(target, actorId, value);
  return [
    replaced ? "图片识别要求已更新" : "图片识别要求已记录",
    "- 范围：下一批图片",
    "- 时限：5 分钟",
    "- 取消：/vision cancel",
  ].join("\n");
}

export function formatVisionImagesCollected(
  imageCount: number,
  maximumImages: number,
  automatic = false,
): string {
  return [
    "图片收集中",
    `- 进度：${imageCount}/${maximumImages} 张`,
    `- 提交：${automatic ? "收齐后自动提交" : "/vision done"}`,
    "- 取消：/vision cancel",
  ].join("\n");
}

export function formatVisionCollectionReady(
  imageCount: number,
  maximumImages: number,
): string {
  return [
    "图片已收齐",
    `- 进度：${imageCount}/${maximumImages} 张`,
    "- 状态：正在自动提交",
  ].join("\n");
}

export function formatVisionCommandTiming(
  value: string,
  timing: VisionCommandTiming,
): string {
  const processingMs = elapsedMilliseconds(
    timing.respondedAtMs,
    timing.receivedAtMs,
  );
  const deliveryMs = timing.createdAtMs === undefined
    ? undefined
    : elapsedMilliseconds(timing.receivedAtMs, timing.createdAtMs);
  return [
    value,
    ...(deliveryMs === undefined
      ? []
      : [`- 接收延迟：${deliveryMs}毫秒`]),
    ...(processingMs === undefined
      ? []
      : [`- Gateway 处理：${processingMs}毫秒`]),
  ].join("\n");
}

function visionCommandUsageError(): UserFacingError {
  return new UserFacingError(
    "vision.command.usage",
    "请使用 /vision <要求>、/vision <2–4> <要求> 或 /vision cancel",
  );
}

function elapsedMilliseconds(
  later: number,
  earlier: number,
): number | undefined {
  if (
    !Number.isSafeInteger(later)
    || !Number.isSafeInteger(earlier)
    || later < earlier
  ) {
    return undefined;
  }
  return later - earlier;
}
