export type AppendedInputKind = "text" | "file" | "image";

export function formatTurnInputAppended(
  kind: AppendedInputKind,
  includesText = false,
): string {
  if (kind === "text") {
    return "已将补充要求追加到当前 Turn。";
  }
  const label = kind === "file" ? "文件" : "图片";
  return `已将${label}${includesText ? "和补充要求" : ""}追加到当前 Turn。`;
}
