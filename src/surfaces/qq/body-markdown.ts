import { BlockList, isIP } from "node:net";
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";

// Local rendering policy only: QQ fetches image URLs. Never resolve DNS here.
const excludedImageAddresses = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) excludedImageAddresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20]] as const) {
  excludedImageAddresses.addSubnet(address, prefix, "ipv6");
}
const globalImageAddresses = new BlockList();
globalImageAddresses.addSubnet("2000::", 3, "ipv6");

function imageDestinationSupported(destination: string): boolean {
  if (/^qqbot-media:\/\/image\/v1\/[A-Za-z0-9_-]{1,4096}$/u.test(destination)) return true;
  if (destination.length > 4096 || !/^https?:\/\//iu.test(destination)) return false;
  try {
    const url = new URL(destination);
    if (!url.hostname || url.username || url.password) return false;
    const host = url.hostname.replace(/^\[|\]$/gu, "").replace(/\.$/u, "");
    const family = isIP(host);
    if (family === 4) return !excludedImageAddresses.check(host, "ipv4");
    if (family === 6) return globalImageAddresses.check(host, "ipv6") && !excludedImageAddresses.check(host, "ipv6");
    return host.length <= 253 && host.includes(".") && !/(?:^|\.)(?:localhost|local|internal)$/iu.test(host)
      && host.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label));
  } catch { return false; }
}

/** Notifications contain literal fields: preserve dollars and ampersands in
 * visible prose, without changing code or link/image destinations. This is an
 * outbound representation only; model bodies and source values stay raw. */
export function escapeQqNotificationLiterals(text: string): string {
  let fence: MarkdownFence | undefined;
  let prose = "";
  let result = "";
  const flush = (): void => {
    result += escapeNotificationProse(prose);
    prose = "";
  };
  for (const originalLine of text.match(/[^\n]*\n|[^\n]+$/gu) ?? []) {
    const line = originalLine.replace(/^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t])+/u, "");
    const previous = fence;
    fence = advanceMarkdownFence(fence, line);
    // Indentation cannot interrupt an existing prose paragraph or code span.
    if (previous || fence || (!prose && /^(?: {4}|\t)/u.test(line)) || !line.trim()) {
      flush();
      result += originalLine;
    } else prose += originalLine;
  }
  flush();
  return result;
}

function escapeNotificationProse(text: string): string {
  // A code span closes only at a run of exactly the same length. Index the
  // runs once so malformed prose cannot cause repeated scans of its suffix.
  const runs = new Map<number, { positions: number[]; next: number }>();
  for (const match of text.matchAll(/`+/gu)) {
    const length = match[0].length;
    const entry = runs.get(length) ?? { positions: [], next: 0 };
    entry.positions.push(match.index);
    runs.set(length, entry);
  }
  let result = "";
  for (let index = 0; index < text.length;) {
    const character = text[index];
    if (character === "\\") {
      let end = index + 1;
      while (text[end] === "\\") end++;
      result += text.slice(index, end);
      if ((end - index) % 2 === 1 && (text[end] === "$" || text[end] === "&" || text[end] === "`")) result += text[end++];
      index = end;
      continue;
    }
    if (character === "`") {
      let end = index + 1;
      while (text[end] === "`") end++;
      const length = end - index;
      const entry = runs.get(length);
      if (entry) while (entry.next < entry.positions.length && entry.positions[entry.next]! < end) entry.next++;
      const close = entry?.positions[entry.next];
      if (close !== undefined) {
        result += text.slice(index, close + length);
        index = close + length;
      } else {
        // An unmatched backtick run is literal Markdown, not an open code span.
        result += text.slice(index, end);
        index = end;
      }
      continue;
    }
    if (character === "]" && text[index + 1] === "(") {
      // Preserve resource identifiers byte for byte. The existing safety scan
      // still decides whether each complete link/image is supported at all.
      const destination = /^\]\((?:https?:\/\/|qqbot-media:\/\/|\/(?!\/))[^\s()\\<&\p{Cc}\p{Cf}]*\)/iu.exec(text.slice(index));
      if (destination) {
        result += destination[0];
        index += destination[0].length;
        continue;
      }
    }
    if ((character === "h" || character === "H") && !/[\p{L}\p{N}_]/u.test(text[index - 1] ?? "")) {
      // QQ may auto-link bare URLs too. Escaping a dollar in that token can
      // change its resource identity, even without an explicit destination.
      const url = /^https?:\/\/[^\s<>`\\\p{Cc}\p{Cf}]+/iu.exec(text.slice(index));
      if (url) {
        try {
          if (new URL(url[0]).hostname) {
            result += url[0];
            index += url[0].length;
            continue;
          }
        } catch { /* A malformed URL remains ordinary visible text. */ }
      }
    }
    result += character === "$" || character === "&" ? `\\${character}` : character;
    index++;
  }
  return result;
}

/** All Markdown presentations share the same capability boundary. Code/review
 * producers own literal wrapping; this scanner does not validate Markdown. */
export function qqNativeMarkdownPrefix(text: string): string {
  let fence: MarkdownFence | undefined;
  let fenceLine = false;
  let inlineTicks = 0;
  let inlineEnd = -1;
  let indented = false;
  const ticks = new Map<number, { positions: number[]; next: number }>();
  for (const match of text.matchAll(/`+/gu)) {
    const entry = ticks.get(match[0].length) ?? { positions: [], next: 0 };
    entry.positions.push(match.index);
    ticks.set(match[0].length, entry);
  }
  for (let index = 0; index < text.length; index++) {
    if (index === 0 || text[index - 1] === "\n") {
      const end = text.indexOf("\n", index);
      const originalLine = text.slice(index, end === -1 ? text.length : end + 1);
      // Recognize code inside quote/list containers conservatively as well.
      const line = originalLine.replace(/^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t])+/u, "");
      const previousFence = fence;
      fence = advanceMarkdownFence(fence, line);
      fenceLine = Boolean(previousFence || fence);
      if (fenceLine) { inlineTicks = 0; inlineEnd = -1; }
      indented = /^(?: {4}|\t)/u.test(line);
    }
    const character = text[index];
    // QQ interaction tags remain capabilities even in code. Ordinary source
    // text such as <redacted>, generics, heredocs and entities is literal inside
    // a code span/fence; it must not make the whole command lose its code box.
    if (character === "<" && /^<(?:qqbot-|@|#|emoji:)/iu.test(text.slice(index))) return text.slice(0, index);
    if (character === "!") {
      if (text[index + 1] === "[") {
        // QQ does not document that code/escapes suppress images. Keep examples
        // literal instead of granting image-fetch capabilities to code text.
        if (fenceLine || inlineTicks || indented || text[index - 1] === "\\") return text.slice(0, index);
        // A bounded, complete inline image is atomic across stream deltas and
        // final Markdown blocks. Titles, nesting and reference images stay literal.
        // A media reference needs 23 scheme/path characters plus its 4096-byte token.
        const image = /^!\[[^[\]\\`!<&\p{Cc}\p{Cf}]{0,1024}\]\(([^\s()\\`<&\p{Cc}\p{Cf}]{1,4119})\)/u.exec(text.slice(index, index + 10_300));
        if (!image || !imageDestinationSupported(image[1]!)) return text.slice(0, index);
        index += image[0].length - 1;
        continue;
      }
    }
    if (character === "`" && !fenceLine) {
      let end = index + 1;
      while (text[end] === "`") end++;
      const count = end - index;
      if (index === inlineEnd) { inlineTicks = 0; inlineEnd = -1; }
      else if (!inlineTicks) {
        let slash = index;
        while (slash > 0 && text[slash - 1] === "\\") slash--;
        const entry = ticks.get(count)!;
        while (entry.next < entry.positions.length && entry.positions[entry.next]! < end) entry.next++;
        const close = entry.positions[entry.next];
        // Escaped or unmatched backticks are prose, not proof that a later
        // link is literal. Blank lines also end an inline-code paragraph.
        if ((index - slash) % 2 === 0 && close !== undefined
          && !/\n[ \t]*\n/u.test(text.slice(end, close))) {
          inlineTicks = count;
          inlineEnd = close;
        }
      }
      index = end - 1;
      continue;
    }
  }
  return text;
}
