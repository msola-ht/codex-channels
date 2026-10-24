type QqReference = { supported: true; quotedText?: string } | { supported: false };

// Local acceptance limits, not limits guaranteed by the QQ API.
const maximumDepth = 4;
const maximumNodes = 16;
const maximumNodeAttachments = 4;
const maximumAttachments = 16;
const maximumTextBytes = 32_000;

/** Decode only QQ's native reference relation; never fetch or authorize quoted content. */
export function decodeQqReference(
  message: Record<string, unknown>,
  extensions: readonly string[],
  currentIndex: string,
): QqReference {
  const references = extensions.filter(entry => entry.startsWith("ref_msg_idx="));
  if (message.ark_data !== undefined) return { supported: false };
  if (message.message_type === 0) {
    return { supported: message.msg_elements === undefined && references.length === 0 };
  }
  if (message.message_type !== 103 || references.length !== 1) return { supported: false };
  const referenceIndex = references[0]!.slice("ref_msg_idx=".length);
  if (!identifier(referenceIndex) || referenceIndex === currentIndex
    || !Array.isArray(message.msg_elements) || message.msg_elements.length !== 1) return { supported: false };
  const root: unknown = message.msg_elements[0];
  if (!record(root) || root.msg_idx !== referenceIndex) return { supported: false };

  const pending: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 1 }];
  const indexes = new Set<string>([currentIndex]);
  const visited = new Set<object>();
  const lines: string[] = [];
  let nodes = 0;
  let attachments = 0;
  let textBytes = 0;
  while (pending.length > 0) {
    const { node, depth } = pending.pop()!;
    if (!record(node) || depth > maximumDepth || ++nodes > maximumNodes || visited.has(node)
      || (node.message_type !== 0 && node.message_type !== 103) || node.ark_data !== undefined
      || typeof node.content !== "string") return { supported: false };
    visited.add(node);
    if (node.msg_idx !== undefined) {
      if (!identifier(node.msg_idx) || indexes.has(node.msg_idx)) return { supported: false };
      indexes.add(node.msg_idx);
    }
    textBytes += Buffer.byteLength(node.content, "utf8");
    if (textBytes > maximumTextBytes || Buffer.from(node.content, "utf8").toString("utf8") !== node.content) {
      return { supported: false };
    }
    if (depth > 1) lines.push(`${"  ".repeat(depth - 1)}[嵌套引用]`);
    lines.push(node.content);
    if (node.attachments !== undefined) {
      if (!Array.isArray(node.attachments) || node.attachments.length > maximumNodeAttachments
        || (attachments += node.attachments.length) > maximumAttachments) return { supported: false };
      for (const attachment of node.attachments) {
        if (!record(attachment)) return { supported: false };
        lines.push(attachmentPlaceholder(attachment.content_type));
      }
    }
    if (node.msg_elements !== undefined) {
      if (!Array.isArray(node.msg_elements) || (node.message_type === 0 && node.msg_elements.length > 0)
        || nodes + pending.length + node.msg_elements.length > maximumNodes) return { supported: false };
      for (let index = node.msg_elements.length - 1; index >= 0; index--) {
        pending.push({ node: node.msg_elements[index], depth: depth + 1 });
      }
    }
  }
  return { supported: true, quotedText: lines.join("\n") };
}

function attachmentPlaceholder(contentType: unknown): string {
  if (typeof contentType !== "string") return "[引用未知附件，未读取]";
  if (contentType.startsWith("image/")) return "[引用图片，未下载]";
  if (contentType === "voice" || contentType.startsWith("audio/")) return "[引用音频，未下载]";
  if (contentType.startsWith("video/")) return "[引用视频，未下载]";
  if (contentType === "file") return "[引用文件，未下载]";
  return "[引用未知附件，未读取]";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/\s/u.test(value)
    && ![...value].some(character => { const code = character.codePointAt(0)!; return code < 32 || code >= 127 && code <= 159; });
}
