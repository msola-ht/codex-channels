import { formatElapsedDuration } from "./elapsed-duration.js";
import type { VisionTokenUsage } from "../conversation-core/index.js";

export type AppendedInputKind = "text" | "file" | "image" | "audio";

export function formatVisionStarted(imageCount: number): string {
  return [
    "## 视觉识别中",
    `- 图片：${imageCount} 张`,
    "- 状态：已发送至视觉 API",
  ].join("\n");
}

export function formatVisionProgress(elapsedSeconds: number): string {
  return [
    "## 视觉识别中",
    `- 已等待：${elapsedSeconds} 秒`,
    "- 状态：上游仍在处理",
  ].join("\n");
}

export function formatVisionCompleted(details: {
  provider: string;
  model: string;
  elapsedMs?: number;
  usage?: VisionTokenUsage;
}, debug = false): string {
  const usage = details.usage;
  const tokenParts = usage === undefined
    ? []
    : [
        ...(usage.cachedInputTokens === undefined
          ? []
          : [
              `  - 输入命中缓存：${formatInteger(usage.cachedInputTokens)}`,
              ...(usage.inputTokens === undefined
                ? []
                : [`  - 输入未命中缓存：${formatInteger(Math.max(0, usage.inputTokens - usage.cachedInputTokens))}`]),
            ]),
        ...(usage.outputTokens === undefined
          ? []
          : [`  - 输出：${formatInteger(usage.outputTokens)}`]),
        ...(usage.reasoningOutputTokens === undefined
          ? []
          : [`  - 其中推理输出：${formatInteger(usage.reasoningOutputTokens)}`]),
      ];
  const totalTokens = usage === undefined
    ? undefined
    : usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return [
    "## 图片识别完成",
    `- API 提供商：${details.provider}`,
    `- 调用模型：${details.model}`,
    ...(!debug || details.elapsedMs === undefined
      ? []
      : [`- 视觉 API 耗时：${formatElapsedDuration(details.elapsedMs)}`]),
    ...(tokenParts.length === 0 || totalTokens === undefined
      ? []
      : [`- **Token**：${formatInteger(totalTokens)}`, ...tokenParts]),
    "",
    "- 正在交给当前模型处理。",
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
