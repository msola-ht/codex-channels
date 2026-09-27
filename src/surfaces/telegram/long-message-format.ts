import { formatMarkdownAsTelegramHtmlChunks } from "./markdown-format.js";
import { escapeTelegramHtml } from "./html-format.js";

const maximumInlineCharacters = 3_500;
const documentThresholdCharacters = 16_000;
const largeCodeBlockLines = 80;
const previewLines = 24;
const maximumEscapedPreviewCodeUnits = 2_600;
const maximumDocumentBytes = 45 * 1024 * 1024;

export type LongFinalMessagePlan =
  | { kind: "html"; chunks: string[] }
  | {
      kind: "document";
      previewHtml: string;
      content: Uint8Array;
      filename: string;
      lineCount: number;
    };

export function planLongFinalMessage(text: string): LongFinalMessagePlan | undefined {
  if (Array.from(text).length <= maximumInlineCharacters) {
    return undefined;
  }

  const lines = text.split("\n");
  const content = Buffer.from(text, "utf8");
  if (
    content.byteLength <= maximumDocumentBytes &&
    (Array.from(text).length > documentThresholdCharacters ||
      maximumFencedCodeLines(lines) >= largeCodeBlockLines)
  ) {
    const previewHtml = escapeTruncatedHtml(
      lines.slice(0, previewLines).join("\n"),
      maximumEscapedPreviewCodeUnits,
    );
    return {
      kind: "document",
      previewHtml: [
        "<b>回复较长，完整内容已作为文件发送</b>",
        "",
        `<pre>${previewHtml}</pre>`,
        "",
        `预览前最多 ${Math.min(previewLines, lines.length)} 行 · 共 ${lines.length} 行`,
      ].join("\n"),
      content,
      filename: "codex-response.md",
      lineCount: lines.length,
    };
  }

  return {
    kind: "html",
    chunks: formatMarkdownAsTelegramHtmlChunks(text),
  };
}

function maximumFencedCodeLines(lines: readonly string[]): number {
  let current = 0;
  let maximum = 0;
  let insideFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (insideFence) {
        maximum = Math.max(maximum, current);
        current = 0;
      }
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) {
      current += 1;
    }
  }
  return Math.max(maximum, current);
}

function escapeTruncatedHtml(text: string, limit: number): string {
  let result = "";
  for (const character of text) {
    const escaped = escapeTelegramHtml(character);
    if (result.length + escaped.length > limit - 1) {
      return `${result}…`;
    }
    result += escaped;
  }
  return result;
}
