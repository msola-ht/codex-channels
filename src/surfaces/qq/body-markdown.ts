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
    if (character === "<" || character === "&") return text.slice(0, index);
    if (character === "!") {
      if (text[index + 1] === "[" || (!finished && index + 1 === text.length)) return text.slice(0, index);
    }
    if (character !== "[") continue;
    // Hold an incomplete link from its opening bracket. Only an explicit HTTP(S)
    // destination can become a link; images, references and client schemes cannot.
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
