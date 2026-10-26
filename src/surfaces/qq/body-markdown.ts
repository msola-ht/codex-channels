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
  let indented = false;
  let ambiguousCode = false;
  for (let index = 0; index < text.length; index++) {
    if (index === 0 || text[index - 1] === "\n") {
      const end = text.indexOf("\n", index);
      const originalLine = text.slice(index, end === -1 ? text.length : end + 1);
      // Recognize code inside quote/list containers conservatively as well.
      const line = originalLine.replace(/^(?: {0,3}>[ \t]?| {0,3}(?:[-+*]|\d{1,9}[.)])[ \t])+/u, "");
      const previousFence = fence;
      fence = advanceMarkdownFence(fence, line);
      fenceLine = Boolean(previousFence || fence);
      if (fenceLine) inlineTicks = 0;
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
      if (!inlineTicks) inlineTicks = count;
      else if (inlineTicks === count) inlineTicks = 0;
      index = end - 1;
      continue;
    }
    if (character !== "[") continue;
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
