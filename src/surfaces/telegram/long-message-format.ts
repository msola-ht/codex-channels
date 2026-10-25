import { formatMarkdownAsTelegramHtml, formatMarkdownAsTelegramHtmlChunks } from "./markdown-format.js";
import { escapeTelegramHtml, hasTelegramReplyHeading } from "./html-format.js";
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";

const maximumInlineCharacters = 3_500;
const documentThresholdCharacters = 16_000;
const largeCodeBlockLines = 80;
const previewLines = 24;
const maximumEscapedPreviewCodeUnits = 2_600;
const maximumDocumentBytes = 45 * 1024 * 1024;
const maximumRichPartCharacters = 5_000;

export type LongFinalMessagePlan =
  | { kind: "html"; chunks: string[] }
  | { kind: "rich"; chunks: string[] }
  | {
      kind: "document";
      previewHtml: string;
      content: Uint8Array;
      filename: string;
      lineCount: number;
    };

export function planLongFinalMessage(text: string, format: "html" | "rich" = "html"): LongFinalMessagePlan | undefined {
  if (format === "html" && Array.from(text).length <= maximumInlineCharacters) {
    return undefined;
  }

  const lines = text.split("\n");
  const content = Buffer.from(text, "utf8");
  if (
    content.byteLength <= maximumDocumentBytes &&
    Array.from(text).length > maximumInlineCharacters &&
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
        "<b>回复较长，以下为内容预览</b>",
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

  const rich = format === "rich" ? richMarkdownChunks(text) : undefined;
  if (rich) return { kind: "rich", chunks: rich };
  return {
    kind: "html",
    chunks: formatMarkdownAsTelegramHtmlChunks(text),
  };
}

/** Split only complete blocks; oversized/unfinished blocks retain HTML fallback. */
function richMarkdownChunks(text: string): string[] | undefined {
  const blocks: string[] = [];
  let block = "";
  let fence: MarkdownFence | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    block += line;
    fence = advanceMarkdownFence(fence, line);
    if (!fence && !line.trim()) { blocks.push(block); block = ""; }
  }
  if (fence) return undefined;
  if (block) blocks.push(block);
  const chunks: string[] = [];
  let chunk = "";
  for (const value of blocks) {
    if (Array.from(value).length > maximumRichPartCharacters) return undefined;
    if (Array.from(chunk).length + Array.from(value).length > maximumRichPartCharacters) {
      chunks.push(chunk); chunk = "";
    }
    chunk += value;
  }
  if (chunk) chunks.push(chunk);
  if (!chunks.length || chunks.some(value => !value.trim() || hasTelegramReplyHeading(
    formatMarkdownAsTelegramHtml(value.split("\n", 1)[0]!) ?? "",
  ))) return undefined;
  return chunks;
}

function maximumFencedCodeLines(lines: readonly string[]): number {
  let current = 0;
  let maximum = 0;
  let fence: MarkdownFence | undefined;
  for (const line of lines) {
    const nextFence = advanceMarkdownFence(fence, line);
    if (nextFence !== fence) {
      if (fence) {
        maximum = Math.max(maximum, current);
        current = 0;
      }
      fence = nextFence;
      continue;
    }
    if (fence) {
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
