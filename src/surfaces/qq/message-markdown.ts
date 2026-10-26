import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import { escapeLifecycleLiteral } from "../lifecycle-presentation.js";
import { qqBodyMarkdownPrefix } from "./body-markdown.js";
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
  const text = input.content;
  if (/[\p{Cf}\p{Cc}]/u.test(text.replace(/\n/gu, ""))) return undefined;
  if (qqBodyMarkdownPrefix(text, true) !== text) return undefined;
  const blocks = markdownBlocks(text);
  if (blocks.some(block => !block.closed)) return undefined;
  if (Buffer.byteLength(text) <= maximumBytes) return [{ ...input }];
  const budget = maximumBytes - Buffer.byteLength("**1/8**\n");
  const chunks: string[] = [];
  let chunk = "";
  for (const { text: value } of blocks) {
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
    ...input, content: `**${index + 1}/${chunks.length}**\n${content}`,
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

/** QQ may commit each pending suffix independently. Preview only complete
 * paragraphs/containers so later frames do not depend on their inline syntax. */
export function qqBodyMarkdownPreview(text: string): string {
  const safe = qqBodyMarkdownPrefix(text);
  let fence: MarkdownFence | undefined;
  let position = 0;
  let boundary = 0;
  for (const line of safe.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    // Match the safety scanner's container handling. A blank line inside a
    // list/quote fence must not commit half of that code block to QQ.
    const content = line.replace(/^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t])+/u, "");
    fence = advanceMarkdownFence(fence, content);
    position += line.length;
    if (!fence && !line.trim() && line.endsWith("\n")) boundary = position;
  }
  return safe.slice(0, boundary);
}

/** Keep unsafe or incomplete blocks literal while later full blocks retain
 * their Markdown. Active bodies retain the original eight-part quota. */
export function planQqBodyMarkdown(input: QqTextMessage, markdownStart = 0):
  readonly { message: QqTextMessage; markdown: boolean }[] | undefined {
  if (input.mode !== "active" || !Number.isSafeInteger(markdownStart)
    || markdownStart < 0 || markdownStart > input.content.length) return undefined;
  if (markdownStart === 0 && Array.from(input.content).length <= QQ_BODY_MARKDOWN_PART_CHARACTERS) {
    const content = qqBodyMarkdownText(input.content);
    const complete = Array.from(content).length <= QQ_BODY_MARKDOWN_PART_CHARACTERS
      ? planQqMessageMarkdown({ ...input, content }, QQ_BODY_MARKDOWN_PART_BYTES) : undefined;
    if (complete) return complete.map(message => ({ message, markdown: true }));
  }
  const markdownBudget = QQ_BODY_MARKDOWN_PART_CHARACTERS - Array.from("**1/8**\n").length;
  const textBudget = QQ_TEXT_PART_BYTES - Buffer.byteLength("[1/8]\n");
  const body = input.content.slice(markdownStart);
  const originalBlocks = markdownBlocks(body);
  const displayBlocks = markdownBlocks(qqBodyMarkdownText(body));
  const blocks = [{ text: input.content.slice(0, markdownStart), closed: false, candidate: input.content.slice(0, markdownStart) },
    ...originalBlocks.map((block, index) => ({ ...block,
      candidate: displayBlocks.length === originalBlocks.length ? displayBlocks[index]!.text : block.text }))];
  // Markdown counts code points; literal text retains its UTF-8 byte budget.
  const chunks: { content: string; size: number; markdown: boolean }[] = [];
  for (const { text: block, closed, candidate } of blocks) {
    if (!block) continue;
    const markdown = closed && !/[\p{Cf}\p{Cc}]/u.test(candidate.replace(/\n/gu, ""))
      && qqBodyMarkdownPrefix(candidate, true) === candidate && Array.from(candidate).length <= markdownBudget;
    if (markdown) {
      const last = chunks.at(-1);
      const size = Array.from(candidate).length;
      if (last?.markdown && last.size + size <= markdownBudget) { last.content += candidate; last.size += size; }
      else chunks.push({ content: candidate, size, markdown: true });
      if (chunks.length > 8) return undefined;
      continue;
    }
    // Plain oversized blocks retain the existing grapheme-safe text behavior.
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(block)) {
      const last = chunks.at(-1);
      const bytes = Buffer.byteLength(segment);
      if (bytes > textBudget) return undefined;
      if (last?.markdown === markdown && last.size + bytes <= textBudget) {
        last.content += segment; last.size += bytes;
      } else chunks.push({ content: segment, size: bytes, markdown });
      if (chunks.length > 8) return undefined;
    }
  }
  if (!chunks.some(chunk => chunk.markdown) || chunks.length > 8 || chunks.some(chunk => !chunk.content.trim())) return undefined;
  return chunks.map((chunk, index) => ({ markdown: chunk.markdown, message: {
    ...input,
    content: chunks.length === 1 ? chunk.content : `${chunk.markdown ? `**${index + 1}/${chunks.length}**` : `[${index + 1}/${chunks.length}]`}\n${chunk.content}`,
  } }));
}

/** Completed standalone local references are display text, never upload requests.
 * Keep the authoritative body and stream offsets unchanged; code examples and
 * ambiguous syntax retain the existing literal fallback. */
export function qqBodyMarkdownText(text: string): string {
  let fence: MarkdownFence | undefined;
  let inlineTicks = 0;
  return text.split("\n").map(line => {
    const previous = fence;
    fence = advanceMarkdownFence(fence, line);
    if (previous || fence) { inlineTicks = 0; return line; }
    const insideCode = inlineTicks > 0;
    for (const run of line.matchAll(/`+/gu)) {
      if (inlineTicks === 0) inlineTicks = run[0].length;
      else if (inlineTicks === run[0].length) inlineTicks = 0;
    }
    if (insideCode || inlineTicks > 0 || /^(?: {4}|\t)/u.test(line)) return line;
    const match = /^([^`[\]\\<>!]*?)(!?)\[([^`[\]\\<>\p{Cc}\p{Cf}]+)\]\((\/(?!\/)[^`[\]()\\<>\p{Cc}\p{Cf}]+)\)[ \t]*$/u.exec(line);
    if (!match) return line;
    const [, prefix, image, label, path] = match;
    return `${prefix}${image ? "本地图片：" : ""}${escapeLifecycleLiteral(label!)} — \`${path}\``;
  }).join("\n");
}

function markdownBlocks(text: string): { text: string; closed: boolean }[] {
  const blocks: { text: string; closed: boolean }[] = [];
  let block = "";
  let fence: MarkdownFence | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    block += line;
    fence = advanceMarkdownFence(fence, line);
    if (!fence && !line.trim()) { blocks.push({ text: block, closed: true }); block = ""; }
  }
  if (block) blocks.push({ text: block, closed: !fence });
  return blocks;
}
