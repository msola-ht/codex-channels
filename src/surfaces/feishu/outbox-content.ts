import { contentTruncatedText } from "../output-copy.js";
import { encodeFeishuPostContent } from "./message-content.js";

const maximumFeishuMessageContentBytes = 20_000;
export const maximumFeishuMessageChunks = 5;
const feishuChunkHeaderReserveBytes = 64;
export const feishuTruncationNotice = `\n\n[${contentTruncatedText}]`;
export const maximumFeishuStreamingElementCharacters = 5_000;
export const maximumFeishuStreamingCards = 5;
const maximumFeishuBufferedStreamCharacters =
  maximumFeishuStreamingElementCharacters * maximumFeishuStreamingCards + 1;

export interface BoundedStreamText {
  text: string;
  truncated: boolean;
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
  const rawHead = characters.slice(0, end).join("");
  const rawTail = characters.slice(end).join("");
  const fenceLanguage = openFenceLanguage(rawHead);
  if (fenceLanguage === null) {
    return [rawHead, rawTail];
  }
  return [
    `${rawHead.endsWith("\n") ? rawHead : `${rawHead}\n`}\`\`\``,
    `\`\`\`${fenceLanguage}\n${rawTail}`,
  ];
}

export function splitFeishuMarkdownCards(
  markdown: string,
  maximumChunks = maximumFeishuMessageChunks,
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
    chunks.push(appendFeishuStreamingTruncation(head));
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
): string[] {
  return splitFeishuContent(
    markdown,
    (value) => Buffer.byteLength(encodeFeishuPostContent(value), "utf8"),
    maximumChunks,
  );
}

function openFenceLanguage(text: string): string | null {
  let language: string | null = null;
  for (const line of text.split("\n")) {
    const match = /^```([A-Za-z0-9_-]*)\s*$/u.exec(line);
    if (match) {
      language = language === null ? (match[1] ?? "") : null;
    }
  }
  return language;
}

export function appendFeishuStreamingTruncation(
  text: string,
  maximumCharacters = maximumFeishuStreamingElementCharacters,
): string {
  const characters = [...text];
  const notice = [...feishuTruncationNotice];
  const closingFence = text.endsWith("\n```") ? [..."\n```"] : [];
  const contentLimit =
    maximumCharacters
    - notice.length
    - closingFence.length;
  const content = closingFence.length > 0
    ? characters.slice(0, Math.min(contentLimit, characters.length - 4))
    : characters.slice(0, contentLimit);
  return [
    ...content,
    ...closingFence,
    ...notice,
  ].join("");
}

function splitFeishuContent(
  text: string,
  measureBytes: (value: string) => number,
  maximumChunks = maximumFeishuMessageChunks,
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
    const lastIndex = payloads.length - 1;
    payloads[lastIndex] = appendWithinByteLimit(
      payloads[lastIndex]!,
      feishuTruncationNotice,
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
