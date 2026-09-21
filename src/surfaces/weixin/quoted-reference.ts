import { createHash } from "node:crypto";

import type { WeixinPartialQuote, WeixinQuotedReference } from "./protocol-types.js";

export interface WeixinCachedQuote {
  text: string;
  truncated: boolean;
}

/** Resolve only the platform's explicit quote relation, after Actor authorization. */
export function resolveWeixinQuotedText(
  reference: WeixinQuotedReference,
  cached: WeixinCachedQuote | undefined,
): string | undefined {
  const body = reference.quotedText ?? cached?.text;
  let text = reference.quotedText === undefined && cached?.truncated ? `${body}…` : body;
  if (reference.quotedPartial) {
    text = body === undefined ? undefined : resolvePartialQuote(body, reference.quotedPartial);
    text ??= "[局部引用无法还原，请重新发送所选文字]";
  } else if (body === undefined && reference.quotedMessageId !== undefined) {
    text = "[引用正文不在当前进程缓存中，请重新发送原文]";
  }
  // The final shared formatter has a bounded quote budget. Keep the body (or
  // unavailable notice) first so a long platform summary cannot displace it.
  return [text, reference.quotedTitle].filter((part) => part !== undefined).join(" | ") || undefined;
}

function occurrenceIndex(text: string, value: string, occurrence: number, from = 0): number {
  let index = from;
  for (let current = 0; current <= occurrence; current += 1) {
    index = text.indexOf(value, index);
    if (index < 0) return -1;
    if (current < occurrence) index += value.length;
  }
  return index;
}

function resolvePartialQuote(text: string, partial: WeixinPartialQuote): string | undefined {
  const start = occurrenceIndex(text, partial.start, partial.startindex);
  if (start < 0) return undefined;
  // The locked upstream observes global and start-relative end indexes. A supplied
  // protocol MD5 must match the selected text before either interpretation is used.
  const ends = partial.quotemd5
    ? [occurrenceIndex(text, partial.end, partial.endindex),
      occurrenceIndex(text, partial.end, partial.endindex, start + partial.start.length)]
    : [occurrenceIndex(text, partial.end, partial.endindex)];
  for (const end of ends) {
    if (end < start) continue;
    const candidate = text.slice(start, end + partial.end.length);
    if (!partial.quotemd5 || createHash("md5").update(candidate, "utf8").digest("hex") === partial.quotemd5.toLowerCase()) {
      return candidate;
    }
  }
  return undefined;
}
