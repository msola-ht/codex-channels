/**
 * Return an unchanged, safe prefix for QQ's native Markdown renderer.
 * Never repair incomplete syntax or append closing fences: replace streams
 * cannot rewrite content already accepted by the platform.
 * Unknown constructs remain in the authoritative body for plain-text delivery.
 */
export function qqBodyMarkdownPrefix(text: string, finished = false): string {
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    // QQ command/mention tags, HTML and entity-encoded syntax are not body capabilities.
    // Apply even inside code: QQ does not document that code fences disable its tags.
    if (character === "<") return text.slice(0, index);
    if (character === "&" && (/[#a-z]/iu.test(text[index + 1] ?? "")
      || (!finished && index + 1 === text.length))) return text.slice(0, index);
    if (character === "!") {
      if (text[index + 1] === "[" || (!finished && index + 1 === text.length)) return text.slice(0, index);
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
    index += link[0].length - 1;
  }
  return text;
}
