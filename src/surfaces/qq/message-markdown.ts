import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
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

/** Keep unsafe or incomplete blocks literal while later full blocks retain
 * their Markdown. Active bodies retain the original eight-part quota. */
export function planQqBodyMarkdown(input: QqTextMessage, markdownStart = 0):
  readonly { message: QqTextMessage; markdown: boolean }[] | undefined {
  if (input.mode !== "active" || !Number.isSafeInteger(markdownStart)
    || markdownStart < 0 || markdownStart > input.content.length) return undefined;
  if (markdownStart === 0 && Array.from(input.content).length <= QQ_BODY_MARKDOWN_PART_CHARACTERS) {
    const complete = planQqMessageMarkdown(input, QQ_BODY_MARKDOWN_PART_BYTES);
    if (complete) return complete.map(message => ({ message, markdown: true }));
  }
  const markdownBudget = QQ_BODY_MARKDOWN_PART_CHARACTERS - Array.from("**1/8**\n").length;
  const textBudget = QQ_TEXT_PART_BYTES - Buffer.byteLength("[1/8]\n");
  const blocks = [{ text: input.content.slice(0, markdownStart), closed: false }, ...markdownBlocks(input.content.slice(markdownStart))];
  // Markdown counts code points; literal text retains its UTF-8 byte budget.
  const chunks: { content: string; size: number; markdown: boolean }[] = [];
  for (const { text: block, closed } of blocks) {
    if (!block) continue;
    const markdown = closed && !/[\p{Cf}\p{Cc}]/u.test(block.replace(/\n/gu, ""))
      && qqBodyMarkdownPrefix(block, true) === block && Array.from(block).length <= markdownBudget;
    if (markdown) {
      const last = chunks.at(-1);
      const size = Array.from(block).length;
      if (last?.markdown && last.size + size <= markdownBudget) { last.content += block; last.size += size; }
      else chunks.push({ content: block, size, markdown: true });
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
