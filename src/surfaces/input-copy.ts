export type AppendedInputKind = "text" | "file" | "image" | "audio";

export function formatVisionStarted(imageCount: number): string {
  const imageLabel = imageCount === 1 ? "图片" : `${imageCount} 张图片`;
  return `${imageLabel}和本条要求已发送到视觉 API，正在识别。`;
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
