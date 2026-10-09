import { DeliveryReceipt } from "../delivery-receipt.js";
import { contentTruncatedText } from "../output-copy.js";
import { encodeFeishuPostContent } from "./message-content.js";
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";

const maximumFeishuMessageContentBytes = 20_000;
export const maximumFeishuMessageChunks = 5;
const feishuChunkHeaderReserveBytes = 64;
export const feishuPreviewNotice = "\n\n[内容预览，完整回复见附件]";
export const feishuTruncationNotice = `\n\n[${contentTruncatedText}]`;
export const maximumFeishuStreamingElementCharacters = 5_000;
export const maximumFeishuStreamingCards = 5;
const maximumFeishuBufferedStreamCharacters =
  maximumFeishuStreamingElementCharacters * maximumFeishuStreamingCards + 1;

export interface BoundedStreamText {
  text: string;
  truncated: boolean;
}

/** Local layout failure; callers can downgrade without treating it as a platform error. */
export class FeishuMarkdownSplitError extends Error {
  constructor() {
    super("飞书消息分片上限不足以完整展示代码围栏");
    this.name = "FeishuMarkdownSplitError";
  }
}

export function boundedStreamText(value: string): BoundedStreamText {
  return appendBoundedStreamText("", value);
}

export function appendBoundedStreamText(
  current: string,
  addition: string,
): BoundedStreamText {
  let remaining =
    maximumFeishuBufferedStreamCharacters - [...current].length;
  if (remaining <= 0 || addition.length === 0) {
    if (addition.length > 0) DeliveryReceipt.current()?.markContentIncomplete();
    return {
      text: current,
      truncated: addition.length > 0,
    };
  }
  let suffix = "";
  let truncated = false;
  for (const character of addition) {
    if (remaining === 0) {
      truncated = true;
      break;
    }
    suffix += character;
    remaining -= 1;
  }
  if (truncated) DeliveryReceipt.current()?.markContentIncomplete();
  return {
    text: `${current}${suffix}`,
    truncated,
  };
}

export function splitFeishuStreamingContent(
  text: string,
  maximumCharacters = maximumFeishuStreamingElementCharacters,
): [string, string] {
  const characters = [...text];
  const reservedEnd = maximumCharacters - 4;
  let end = reservedEnd;
  for (
    let index = reservedEnd;
    index >= Math.floor(reservedEnd * 0.75);
    index -= 1
  ) {
    if (characters[index - 1] === "\n") {
      end = index;
      break;
    }
  }
  // 围栏行不可切开；关闭预算跟随实际围栏长度，而不是固定三反引号。
  while (end > 0) {
    let offset = 0;
    let fence: MarkdownFence | undefined;
    let delimiterStart: number | undefined;
    for (const line of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
      const lineLength = [...line].length;
      const next = advanceMarkdownFence(fence, line);
      if (offset < end && offset + lineLength > end && next !== fence) {
        delimiterStart = offset;
        break;
      }
      if (offset + lineLength > end) break;
      fence = next;
      offset += lineLength;
      if (offset >= end) break;
    }
    if (delimiterStart !== undefined) {
      end = delimiterStart;
      continue;
    }
    const rawHead = characters.slice(0, end).join("");
    const closing = fence === undefined ? "" : `${rawHead.endsWith("\n") ? "" : "\n"}${fence.marker}`;
    if (end + [...closing].length > maximumCharacters) {
      end -= end + [...closing].length - maximumCharacters;
      continue;
    }
    const rawTail = characters.slice(end).join("");
    const tail = fence === undefined ? rawTail : `${fence.opening}\n${rawTail}`;
    // Reopening a fence must still consume source content, not reproduce the entire input.
    if ([...tail].length >= characters.length) throw new FeishuMarkdownSplitError();
    return [rawHead + closing, tail];
  }
  throw new FeishuMarkdownSplitError();
}

export function splitFeishuMarkdownCards(
  markdown: string,
  maximumChunks = maximumFeishuMessageChunks,
  truncationNotice = feishuTruncationNotice,
): string[] {
  const chunks: string[] = [];
  let remaining = markdown;
  while (
    [...remaining].length > maximumFeishuStreamingElementCharacters
    && chunks.length < maximumChunks - 1
  ) {
    const [head, tail] = splitFeishuStreamingContent(remaining);
    chunks.push(head);
    remaining = tail;
  }
  if ([...remaining].length > maximumFeishuStreamingElementCharacters) {
    const [head] = splitFeishuStreamingContent(remaining);
    chunks.push(appendFeishuStreamingTruncation(head, maximumFeishuStreamingElementCharacters, truncationNotice));
  } else {
    chunks.push(remaining);
  }
  return chunks;
}

export function splitFeishuText(text: string): string[] {
  return splitFeishuContent(
    text,
    (value) => Buffer.byteLength(value, "utf8"),
  );
}

export function splitFeishuPost(
  markdown: string,
  maximumChunks = maximumFeishuMessageChunks,
  truncationNotice = feishuTruncationNotice,
): string[] {
  return splitFeishuContent(
    markdown,
    (value) => Buffer.byteLength(encodeFeishuPostContent(value), "utf8"),
    maximumChunks,
    truncationNotice,
  );
}

export function appendFeishuStreamingTruncation(
  text: string,
  maximumCharacters = maximumFeishuStreamingElementCharacters,
  truncationNotice = feishuTruncationNotice,
): string {
  DeliveryReceipt.current()?.markContentIncomplete();
  const contentLimit = maximumCharacters - [...truncationNotice].length;
  const content = [...text].length <= contentLimit ? text
    : splitFeishuStreamingContent(text, contentLimit)[0];
  return content + truncationNotice;
}

function splitFeishuContent(
  text: string,
  measureBytes: (value: string) => number,
  maximumChunks = maximumFeishuMessageChunks,
  truncationNotice = feishuTruncationNotice,
): string[] {
  if (measureBytes(text) <= maximumFeishuMessageContentBytes) {
    return [text];
  }
  const payloadLimit =
    maximumFeishuMessageContentBytes - feishuChunkHeaderReserveBytes;
  const payloads: string[] = [];
  const characters = [...text];
  let offset = 0;
  while (
    offset < characters.length
    && payloads.length < maximumChunks
  ) {
    const end = findLargestFittingEnd(
      characters,
      offset,
      payloadLimit,
      measureBytes,
    );
    if (end === offset) {
      throw new Error("飞书消息分片上限不足以容纳单个字符");
    }
    payloads.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  if (offset < characters.length) {
    DeliveryReceipt.current()?.markContentIncomplete();
    const lastIndex = payloads.length - 1;
    payloads[lastIndex] = appendWithinByteLimit(
      payloads[lastIndex]!,
      truncationNotice,
      payloadLimit,
      measureBytes,
    );
  }
  return payloads.map(
    (payload, index) => `（${index + 1}/${payloads.length}）\n${payload}`,
  );
}

function findLargestFittingEnd(
  characters: readonly string[],
  offset: number,
  byteLimit: number,
  measureBytes: (value: string) => number,
): number {
  let low = offset + 1;
  let high = characters.length;
  let best = offset;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = characters.slice(offset, middle).join("");
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function appendWithinByteLimit(
  text: string,
  suffix: string,
  byteLimit: number,
  measureBytes: (value: string) => number,
): string {
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${suffix}`;
    if (measureBytes(candidate) <= byteLimit) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, best).join("")}${suffix}`;
}
