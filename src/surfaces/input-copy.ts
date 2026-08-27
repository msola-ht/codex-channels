export type AppendedInputKind = "text" | "file" | "image" | "audio";

export function formatTurnInputAppended(
  kind: AppendedInputKind,
  includesText = false,
  appendedText?: string,
): string {
  if (kind === "text") {
    const text = appendedText?.trim();
    if (!text) return "已将补充要求追加到当前 Turn。";
    const quoted = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    return `已将补充要求追加到当前 Turn：\n\n> ${quoted.replaceAll("\n", "\n> ")}`;
  }
  const label = kind === "file" ? "文件" : kind === "audio" ? "语音" : "图片";
  return `已将${label}${includesText ? "和补充要求" : ""}追加到当前 Turn。`;
}
