import { formatElapsedDuration } from "./elapsed-duration.js";
import type { VisionTokenUsage } from "../conversation-core/index.js";

export type AppendedInputKind = "text" | "file" | "image" | "audio";

export function formatVisionStarted(imageCount: number): string {
  return [
    "视觉识别中",
    `- 图片：${imageCount} 张`,
    "- 状态：已发送至视觉 API",
  ].join("\n");
}

export function formatVisionProgress(elapsedSeconds: number): string {
  return [
    "视觉识别中",
    `- 已等待：${elapsedSeconds} 秒`,
    "- 状态：上游仍在处理",
  ].join("\n");
}

export function formatVisionCompleted(details: {
  model: string;
  elapsedMs?: number;
  usage?: VisionTokenUsage;
}): string {
  const tokenParts = details.usage === undefined
    ? []
    : [
        ...(details.usage.inputTokens === undefined
          ? []
          : [`输入 ${formatInteger(details.usage.inputTokens)}`]),
        ...(details.usage.outputTokens === undefined
          ? []
          : [`输出 ${formatInteger(details.usage.outputTokens)}`]),
        ...(details.usage.totalTokens === undefined
          ? []
          : [`总计 ${formatInteger(details.usage.totalTokens)}`]),
      ];
  return [
    "图片识别完成",
    `- 识别模型：${details.model}`,
    ...(details.elapsedMs === undefined
      ? []
      : [`- 视觉 API 耗时：${formatElapsedDuration(details.elapsedMs)}`]),
    ...(tokenParts.length === 0 ? [] : [`- Token 用量：${tokenParts.join(" · ")}`]),
    "",
    "正在交给当前模型处理。",
  ].join("\n");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}

export function formatTurnInputAppended(
  kind: AppendedInputKind,
  includesText = false,
): string {
  if (kind === "text") {
    return "已将补充要求追加到当前 Turn。";
  }
  const label = kind === "file" ? "文件" : kind === "audio" ? "语音" : "图片";
  return `已将${label}${includesText ? "和补充要求" : ""}追加到当前 Turn。`;
}
