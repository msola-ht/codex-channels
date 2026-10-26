import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import { escapeLifecycleLiteral } from "../lifecycle-presentation.js";
import { escapeQqNotificationLiterals, qqNativeMarkdownPrefix } from "./body-markdown.js";
import { QQ_BODY_MARKDOWN_PART_BYTES, QQ_BODY_MARKDOWN_PART_CHARACTERS, QQ_TEXT_PART_BYTES, type QqTextMessage } from "./protocol.js";

/** Preserve exact review/code text inside a fixed fence. Unsupported platform
 * syntax, invisible characters and fence collisions retain the literal path. */
export function qqLiteralMarkdown(content: string): string | undefined {
  if (content.includes("```") || /[\p{Cf}\p{Cc}]/u.test(content.replace(/[\t\r\n]/gu, ""))) return undefined;
  const candidate = `\`\`\`text\n${content}\n\`\`\``;
  return qqNativeMarkdownPrefix(candidate) === candidate ? candidate : undefined;
}

/** Optional representation for already validated notifications and command text.
 * Choose the whole plan before sending; never downgrade after a network attempt.
 */
export function planQqMessageMarkdown(input: QqTextMessage, maximumBytes = QQ_TEXT_PART_BYTES): readonly QqTextMessage[] | undefined {
  // Notifications and progress use this planner without the body-specific
  // preprocessing below. Convert completed local references here as well so
  // they do not force the whole Markdown representation to plain text.
  const original = qqBodyMarkdownText(input.content);
  if (/[\p{Cf}\p{Cc}]/u.test(original.replace(/[\t\r\n]/gu, ""))) return undefined;
  if (qqNativeMarkdownPrefix(original) !== original) return undefined;
  const blocks = markdownBlocks(original);
  if (blocks.some(block => !block.closed)) return undefined;
  const text = escapeQqNotificationLiterals(original);
  if (Buffer.byteLength(text) <= maximumBytes) return [{ ...input, content: text }];
  const budget = maximumBytes - Buffer.byteLength("[1/8]\n\n");
  const chunks: string[] = [];
  let chunk = "";
  for (const { text: block } of blocks) {
    const value = escapeQqNotificationLiterals(block);
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
    ...input, content: `[${index + 1}/${chunks.length}]\n\n${content}`,
    ...(input.mode === "passive" ? { sequence: input.sequence + index } : {}),
  }));
}

/** Stable blocks share the final body's projection and capability policy.
 * Offsets remain in the original body; only the byte budget uses display text. */
export function qqBodyMarkdownCompletePrefix(text: string, maximumEnd: number, maximumBytes: number): string {
  let end = 0;
  let bytes = 0;
  for (const block of markdownBlocks(text)) {
    if (!block.closed || end + block.text.length > maximumEnd) break;
    const display = qqBodyMarkdownText(block.text);
    if (qqNativeMarkdownPrefix(display) !== display) break;
    const blockBytes = Buffer.byteLength(display);
    if (bytes + blockBytes > maximumBytes) break;
    bytes += blockBytes;
    end += block.text.length;
  }
  return text.slice(0, end);
}

/** Native Markdown for complete model prose. Only capability restrictions,
 * resource limits require a literal/file plan. */
export function planQqBodyMarkdown(input: QqTextMessage):
  readonly { message: QqTextMessage; markdown: boolean }[] | undefined {
  if (input.mode !== "active") return undefined;
  const content = qqBodyMarkdownText(input.content);
  if (qqNativeMarkdownPrefix(content) !== content) return undefined;
  const blocks = markdownBlocks(content);
  const rendered = content;
  if (Array.from(rendered).length <= QQ_BODY_MARKDOWN_PART_CHARACTERS
    && Buffer.byteLength(rendered) <= QQ_BODY_MARKDOWN_PART_BYTES) {
    return [{ message: { ...input, content: rendered }, markdown: true }];
  }
  const markdownBudget = QQ_BODY_MARKDOWN_PART_CHARACTERS - Array.from("[1/8]\n\n").length;
  const chunks: string[] = [];
  let chunk = "";
  let size = 0;
  for (const block of blocks) {
    const display = block.text;
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
    ...input, content: `[${index + 1}/${chunks.length}]\n\n${value}`,
  } }));
}

/** Local file references are display text, never upload requests. All other
 * Markdown passes through to QQ unchanged. Keep authoritative body offsets raw. */
export function qqBodyMarkdownText(text: string): string {
  let fence: MarkdownFence | undefined;
  let inlineTicks = 0;
  let labelDepth = 0;
  let destinationDepth = 0;
  return text.split("\n").map(line => {
    const previous = fence;
    const contained = line.replace(/^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t])+/u, "");
    fence = advanceMarkdownFence(fence, contained);
    if (previous || fence || !contained.trim() || /^(?: {4}|\t)/u.test(contained)) {
      inlineTicks = 0;
      labelDepth = 0;
      destinationDepth = 0;
      return line;
    }
    let display = "";
    for (let index = 0; index < line.length;) {
      if (line[index] === "\\") {
        display += line[index] + (line[index + 1] ?? "");
        index += line[index + 1] === undefined ? 1 : 2;
        continue;
      }
      // An unsupported outer link must remain opaque. Otherwise a nested
      // local-looking reference could rewrite its label or HTTP destination
      // into a different construct which the final safety scan accepts.
      if (destinationDepth > 0) {
        if (line[index] === "(") destinationDepth++;
        else if (line[index] === ")") destinationDepth--;
        display += line[index++];
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
      if (inlineTicks === 0 && labelDepth === 0) {
        const local = /^(!?)\[([^[\]\\`<>&\p{Cc}\p{Cf}]+)\]\((?:<([^<>`&\p{Cc}\p{Cf}]+)>|([^\s()`<>&\p{Cc}\p{Cf}]+))\)/u
          .exec(line.slice(index));
        const localPath = local?.[3] ?? local?.[4];
        if (local && localPath && (local[1] === "!" || line[index - 1] !== "!") && isLocalReference(localPath)) {
          const [, image, label] = local;
          display += qqLocalReferenceText(label!, localPath, image === "!");
          index += local[0].length;
          continue;
        }
      }
      if (inlineTicks === 0) {
        if (line[index] === "[") labelDepth++;
        else if (line[index] === "]" && labelDepth > 0) {
          labelDepth--;
          if (labelDepth === 0 && line[index + 1] === "(") {
            display += "](";
            index += 2;
            destinationDepth = 1;
            continue;
          }
        }
      }
      display += line[index];
      index++;
    }
    return display;
  }).join("\n");
}

function isLocalReference(path: string): boolean {
  // Display only: do not resolve relative paths, decode file URIs, read files
  // or turn server-local destinations into client-side links.
  if (path.startsWith("//") || path.startsWith("\\") || path.endsWith("\\")) return false;
  if (/^[a-z]:[\\/]/iu.test(path)) return true;
  if (path.startsWith("/")) return true;
  if (/^file:\/\/\/(?!\/).+/iu.test(path)) return true;
  return !/^[a-z][a-z0-9+.-]*:/iu.test(path) && !/[?#:]/u.test(path)
    && path !== "." && path !== "..";
}

function qqLocalReferenceText(label: string, path: string, image: boolean): string {
  if (image) return `本地图片：${escapeLifecycleLiteral(label)} — \`${path}\``;
  // Match Telegram's compact file-reference presentation without host-OS path
  // parsing. A :line suffix is part of the displayed basename. Explicit code
  // paths never reach this conversion and retain their complete spelling.
  const filename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  return `\`${filename || path}\``;
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
