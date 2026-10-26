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

/** QQ interprets unescaped dollars as formula delimiters. Keep them literal in
 * visible Markdown text, without changing code or link/image destinations.
 * This is an outbound representation only; source text and offsets stay raw. */
export function escapeQqMarkdownDollars(text: string): string {
  return renderQqMarkdownDollars(text).content;
}

/** Hold only an unfinished code-span interpretation that could change how a
 * dollar already present is rendered. Return raw text so stream offsets stay raw. */
export function qqMarkdownDollarStablePrefix(text: string): string {
  return text.slice(0, renderQqMarkdownDollars(text).stableEnd);
}

function renderQqMarkdownDollars(text: string): { content: string; stableEnd: number } {
  let fence: MarkdownFence | undefined;
  let prose = "";
  let result = "";
  let stableEnd = text.length;
  const flush = (final = false): void => {
    result += escapeProseDollars(prose, final ? offset => {
      stableEnd = Math.min(stableEnd, text.length - prose.length + offset);
    } : undefined);
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
  flush(true);
  return { content: result, stableEnd };
}

function escapeProseDollars(text: string, unclosedCodeDollar?: (offset: number) => void): string {
  // A code span closes only at a run of exactly the same length. Index the
  // runs once so malformed prose cannot cause repeated scans of its suffix.
  const runs = new Map<number, { positions: number[]; next: number }>();
  const lastDollar = text.lastIndexOf("$");
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
      if ((end - index) % 2 === 1 && (text[end] === "$" || text[end] === "`")) result += text[end++];
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
        // A closing run at the current stream edge can still grow on the next
        // delta and cease to match this opening run.
        const dollar = text.indexOf("$", end);
        if (close + length === text.length && dollar >= end && dollar < close) unclosedCodeDollar?.(index);
        result += text.slice(index, close + length);
        index = close + length;
      } else {
        // An unmatched backtick run is literal Markdown, not an open code span.
        if (lastDollar >= end) unclosedCodeDollar?.(index);
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
    result += character === "$" ? "\\$" : character;
    index++;
  }
  return result;
}

/**
 * Return an unchanged, safe prefix for QQ's native Markdown renderer.
 * Never repair incomplete syntax or append closing fences: replace streams
 * cannot rewrite content already accepted by the platform.
 * Unknown constructs remain in the authoritative body for plain-text delivery.
 */
export function qqBodyMarkdownPrefix(text: string, finished = false): string {
  let fence: MarkdownFence | undefined;
  let fenceLine = false;
  let inlineTicks = 0;
  let inlineEnd = -1;
  let indented = false;
  let ambiguousCode = false;
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
    // QQ command/mention tags, HTML and entity-encoded syntax are not body capabilities.
    // Apply even inside code: QQ does not document that code fences disable its tags.
    // A literal left arrow cannot open an HTML/QQ tag. Hold a lone '<'
    // across deltas until the following '-' establishes that distinction.
    if (character === "<" && text[index + 1] !== "-") return text.slice(0, index);
    if (character === "&" && (/[#a-z]/iu.test(text[index + 1] ?? "")
      || (!finished && index + 1 === text.length))) return text.slice(0, index);
    if (character === "!") {
      if (!finished && index + 1 === text.length) return text.slice(0, index);
      if (text[index + 1] === "[") {
        // QQ does not document that code/escapes suppress images. Keep examples
        // literal instead of granting image-fetch capabilities to code text.
        if (fenceLine || inlineTicks || indented || ambiguousCode || text[index - 1] === "\\") return text.slice(0, index);
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
    if (character !== "[") continue;
    // Code spans and fenced or indented code keep link-like text literal.
    // QQ tags/entities and images remain conservatively rejected above.
    if (inlineTicks || fenceLine) continue;
    // Plain brackets (including task markers and code) do not grant link
    // capabilities. Keep an unresolved closing bracket until its next
    // non-whitespace character proves it cannot become a link or reference.
    const close = text.indexOf("]", index + 1);
    if (close === -1) {
      if (!finished) return text.slice(0, index);
      continue;
    }
    const following = text.slice(close + 1).match(/^\s*(.)/su)?.[1];
    if (following === undefined && !finished) return text.slice(0, index);
    if (following === "[" || following === ":") return text.slice(0, index);
    if (following !== "(") continue;
    // Only a complete, simple HTTP(S) destination can become a link.
    const link = /^\[[^[\]\r\n\\!<&\p{Cc}]*\]\((https?:\/\/[^\s()\\<&\p{Cc}\p{Cf}]+)\)/iu.exec(text.slice(index));
    if (!link) return text.slice(0, index);
    try {
      const url = new URL(link[1]!);
      if (!url.hostname || url.username || url.password || (url.protocol !== "http:" && url.protocol !== "https:")) {
        return text.slice(0, index);
      }
    } catch { return text.slice(0, index); }
    // The simple-link recognizer does not parse inline-code precedence inside
    // labels/destinations. Do not allow a later image under that uncertainty.
    if (link[0].includes("`")) ambiguousCode = true;
    index += link[0].length - 1;
  }
  return text;
}
