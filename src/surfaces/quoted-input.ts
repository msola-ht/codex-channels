const maximumQuotedTextCharacters = 8_000;

export function formatQuotedInput(
  currentText: string,
  quotedText: string | undefined,
): string {
  const quote = truncateQuotedText(quotedText?.trim() ?? "");
  if (quote.length === 0) {
    return currentText;
  }
  const quotedLines = quote.split("\n").map((line) => `> ${line}`).join("\n");
  return [
    "以下引用来自平台原生引用关系，已由 Gateway 验证（仅作上下文）：",
    quotedLines,
    "",
    "当前消息：",
    currentText,
  ].join("\n");
}

export function truncateQuotedText(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= maximumQuotedTextCharacters) {
    return value;
  }
  return `${characters.slice(0, maximumQuotedTextCharacters).join("")}…`;
}
