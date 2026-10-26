import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import { escapeLifecycleLiteral } from "../lifecycle-presentation.js";
import { escapeQqMarkdownDollars, qqBodyMarkdownPrefix } from "./body-markdown.js";
import { QQ_BODY_MARKDOWN_PART_BYTES, QQ_BODY_MARKDOWN_PART_CHARACTERS, QQ_TEXT_PART_BYTES, QqProtocolError, type QqTextMessage } from "./protocol.js";

/** Preserve exact review/code text inside a fixed fence. Unsupported platform
 * syntax, invisible characters and fence collisions retain the literal path. */
export function qqLiteralMarkdown(content: string): string | undefined {
  if (content.includes("```") || /[\p{Cf}\p{Cc}]/u.test(content.replace(/\n/gu, ""))) return undefined;
  const candidate = `\`\`\`text\n${content}\n\`\`\``;
  return qqBodyMarkdownPrefix(candidate, true) === candidate ? candidate : undefined;
}

/** Optional representation for already validated notifications and command text.
 * Choose the whole plan before sending; never downgrade after a network attempt.
 */
export function planQqMessageMarkdown(input: QqTextMessage, maximumBytes = QQ_TEXT_PART_BYTES): readonly QqTextMessage[] | undefined {
  // Notifications and progress use this planner without the body-specific
  // preprocessing below. Convert completed local references here as well so
  // they do not force the whole Markdown representation to plain text.
  const original = qqBodyMarkdownText(input.content);
  if (/[\p{Cf}\p{Cc}]/u.test(original.replace(/\n/gu, ""))) return undefined;
  if (qqBodyMarkdownPrefix(original, true) !== original) return undefined;
  const blocks = markdownBlocks(original);
  if (blocks.some(block => !block.closed)) return undefined;
  const text = escapeQqMarkdownDollars(original);
  if (Buffer.byteLength(text) <= maximumBytes) return [{ ...input, content: text }];
  const budget = maximumBytes - Buffer.byteLength("[1/8]\n");
  const chunks: string[] = [];
  let chunk = "";
  for (const { text: block } of blocks) {
    const value = escapeQqMarkdownDollars(block);
    if (Buffer.byteLength(value) > budget) return undefined;
    if (Buffer.byteLength(chunk) + Buffer.byteLength(value) > budget) {
      chunks.push(chunk); chunk = "";
    }
    chunk += value;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 8 || chunks.some(value => !value.trim())
    || (input.mode === "passive" && input.sequence + chunks.length - 1 > 4)) return undefined;
  return chunks.map((content, index) => ({
    ...input, content: `[${index + 1}/${chunks.length}]\n${content}`,
    ...(input.mode === "passive" ? { sequence: input.sequence + index } : {}),
  }));
}

/** A continuation may resume Markdown only at a complete original block. */
export function qqBodyMarkdownRestart(text: string, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new QqProtocolError("message", "invalid-input");
  let position = 0;
  for (const block of markdownBlocks(text)) {
    if (position >= offset) return position;
    position += block.text.length;
  }
  return text.length;
}

/** Select one representation for the whole body. A partial continuation or
 * unsupported construct retains the complete literal text/file plan; do not
 * manufacture extra bubbles by switching formats between paragraphs. */
export function planQqBodyMarkdown(input: QqTextMessage, markdownStart = 0):
  readonly { message: QqTextMessage; markdown: boolean }[] | undefined {
  if (input.mode !== "active" || markdownStart !== 0) return undefined;
  const content = qqBodyMarkdownText(input.content);
  if (/[\p{Cf}\p{Cc}]/u.test(content.replace(/\n/gu, ""))
    || qqBodyMarkdownPrefix(content, true) !== content) return undefined;
  const blocks = markdownBlocks(content);
  if (blocks.some(block => !block.closed)) return undefined;
  const rendered = escapeQqMarkdownDollars(content);
  if (Array.from(rendered).length <= QQ_BODY_MARKDOWN_PART_CHARACTERS
    && Buffer.byteLength(rendered) <= QQ_BODY_MARKDOWN_PART_BYTES) {
    return [{ message: { ...input, content: rendered }, markdown: true }];
  }
  const markdownBudget = QQ_BODY_MARKDOWN_PART_CHARACTERS - Array.from("[1/8]\n").length;
  const chunks: string[] = [];
  let chunk = "";
  let size = 0;
  for (const block of blocks) {
    const display = escapeQqMarkdownDollars(block.text);
    const length = Array.from(display).length;
    if (length > markdownBudget) return undefined;
    if (size + length > markdownBudget) { chunks.push(chunk); chunk = ""; size = 0; }
    chunk += display;
    size += length;
    if (chunks.length >= 8) return undefined;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.length > 8 || chunks.some(value => !value.trim())) return undefined;
  return chunks.map((value, index) => ({ markdown: true, message: {
    ...input, content: `[${index + 1}/${chunks.length}]\n${value}`,
  } }));
}

/** Completed local references are display text, never upload requests. Convert
 * them anywhere in ordinary prose or list content so a valid file reference
 * does not force the surrounding Markdown to split into a text message. Keep
 * the authoritative body and stream offsets unchanged; code examples and
 * ambiguous syntax retain the existing literal fallback. */
export function qqBodyMarkdownText(text: string): string {
  let fence: MarkdownFence | undefined;
  let inlineTicks = 0;
  return text.split("\n").map(line => {
    const previous = fence;
    const contained = line.replace(/^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t])+/u, "");
    fence = advanceMarkdownFence(fence, contained);
    if (previous || fence) { inlineTicks = 0; return line; }
    if (/^(?: {4}|\t)/u.test(contained)) { inlineTicks = 0; return line; }
    let display = "";
    for (let index = 0; index < line.length;) {
      if (line[index] === "\\") {
        display += line[index] + (line[index + 1] ?? "");
        index += line[index + 1] === undefined ? 1 : 2;
        continue;
      }
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end++;
        const ticks = end - index;
        if (inlineTicks === 0) inlineTicks = ticks;
        else if (inlineTicks === ticks) inlineTicks = 0;
        display += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineTicks === 0) {
        const local = /^(!?)\[([^[\]\\`<>&\p{Cc}\p{Cf}]+)\]\((\/(?!\/)[^\s()\\`<>&\p{Cc}\p{Cf}]+)\)/u
          .exec(line.slice(index));
        if (local) {
          const [, image, label, path] = local;
          display += qqLocalReferenceText(label!, path!, image === "!");
          index += local[0].length;
          continue;
        }
      }
      display += line[index];
      index++;
    }
    return display;
  }).join("\n");
}

function qqLocalReferenceText(label: string, path: string, image: boolean): string {
  const displayLabel = escapeLifecycleLiteral(label);
  if (image) return `本地图片：${displayLabel} — \`${path}\``;
  const line = /:(\d{1,9})$/u.exec(path)?.[1];
  return `${displayLabel}${line === undefined ? "" : `（第 ${line} 行）`}：\`${path}\``;
}

function markdownBlocks(text: string): { text: string; closed: boolean }[] {
  const blocks: { text: string; closed: boolean }[] = [];
  let block = "";
  let fence: MarkdownFence | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    block += line;
    fence = advanceMarkdownFence(fence, line.replace(/^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t])+/u, ""));
    if (!fence && !line.trim()) { blocks.push({ text: block, closed: true }); block = ""; }
  }
  if (block) blocks.push({ text: block, closed: !fence });
  return blocks;
}
