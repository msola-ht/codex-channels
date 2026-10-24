import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import { qqBodyMarkdownPrefix } from "./body-markdown.js";
import { QQ_TEXT_PART_BYTES, type QqTextMessage } from "./protocol.js";

/** Optional representation for already validated notifications and command text.
 * Choose the whole plan before sending; never downgrade after a network attempt.
 */
export function planQqMessageMarkdown(input: QqTextMessage): readonly QqTextMessage[] | undefined {
  const text = input.content;
  if (qqBodyMarkdownPrefix(text, true) !== text) return undefined;
  if (Buffer.byteLength(text) <= QQ_TEXT_PART_BYTES) return [{ ...input }];
  const budget = QQ_TEXT_PART_BYTES - Buffer.byteLength("**1/8**\n");
  const blocks: string[] = [];
  let block = "";
  let fence: MarkdownFence | undefined;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    block += line;
    fence = advanceMarkdownFence(fence, line);
    if (!fence && !line.trim()) { blocks.push(block); block = ""; }
  }
  if (block) blocks.push(block);
  const chunks: string[] = [];
  let chunk = "";
  for (const value of blocks) {
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
