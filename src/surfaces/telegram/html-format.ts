import { splitTelegramText } from "./format.js";
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import type { LifecyclePresentation, LifecyclePresentationField } from "../lifecycle-presentation.js";

export const telegramInteractionReplyHeading = "Codex 交互回复";

export function hasTelegramReplyHeading(html: string): boolean {
  return html.split("\n", 1)[0]!.replace(/<[^>]+>/g, "") === telegramInteractionReplyHeading;
}

// Only the interaction sender may emit this heading in bold at the start of a message.
// Preserve ordinary content while keeping it distinct from a reply prompt after restart.
export function protectTelegramReplyHeading(html: string): string {
  const boundary = html.indexOf("\n");
  const firstLine = boundary < 0 ? html : html.slice(0, boundary);
  return hasTelegramReplyHeading(html)
    ? firstLine.replace(/<\/?b>/g, "") + (boundary < 0 ? "" : html.slice(boundary))
    : html;
}

export function formatTelegramPanelChunks(text: string | LifecyclePresentation, limit = 3_600): string[] {
  const contentLimit = Math.max(1, limit - 128);
  if (typeof text !== "string") return formatLifecycleChunks(text, contentLimit);
  let fence: MarkdownFence | undefined;
  return splitTelegramText(text, contentLimit).map((chunk) => {
    const opening = fence?.opening;
    for (const line of chunk.split("\n")) {
      fence = advanceMarkdownFence(fence, line);
    }
    const balanced = [
      ...(opening ? [opening] : []),
      chunk,
      ...(fence ? [fence.marker] : []),
    ].join("\n");
    return formatTelegramPanelHtml(balanced);
  });
}

interface LifecycleHtmlFragment {
  text: string;
  bold?: boolean;
}

/** Only typed lifecycle panels use this path; generic panels retain their parser. */
function formatLifecycleChunks(presentation: LifecyclePresentation, limit: number): string[] {
  const fragments: LifecycleHtmlFragment[] = [];
  const append = (text: string, bold = false): void => { fragments.push({ text, bold }); };
  const field = (value: LifecyclePresentationField, depth = 0): void => {
    append(`\n${"  ".repeat(depth)}• `);
    if ("title" in value) {
      append(value.title, true);
      if (value.value !== undefined) append(`：${value.value}`);
      for (const child of value.fields) field(child, depth + 1);
    } else {
      append(`${value.label}：`, true);
      append(value.value);
      for (const child of value.subfields ?? []) field(child, depth + 1);
    }
  };
  append(presentation.title, presentation.titleStyle === "emphasis" || presentation.titleDetail !== undefined
    || presentation.fields.length > 0 || (presentation.sections?.length ?? 0) > 0);
  if (presentation.titleDetail !== undefined) append(` · ${presentation.titleDetail}`);
  if (presentation.fields.length > 0) append("\n");
  for (const value of presentation.fields) field(value);
  for (const section of presentation.sections ?? []) {
    append("\n\n");
    append(section.title, true);
    for (const value of section.fields) field(value);
  }
  if (presentation.footer) {
    append("\n\n");
    append(`${presentation.footer.label}：`, true);
    append(presentation.footer.value);
  }

  // Escape before accounting for the existing panel budget, but split only
  // between source code points. Every chunk closes its own formatting tags.
  const chunks: string[] = [];
  let chunk = "";
  let length = 0;
  let bold = false;
  const flush = (): void => {
    if (chunk) chunks.push(protectTelegramReplyHeading(chunk + (bold ? "</b>" : "")));
    chunk = "";
    length = 0;
    bold = false;
  };
  for (const fragment of fragments) {
    for (const character of fragment.text) {
      const escaped = escapeTelegramHtml(character);
      const encodedLength = Array.from(escaped).length;
      const desiredBold = fragment.bold === true;
      if (encodedLength + (desiredBold ? 7 : 0) > limit) {
        throw new Error("Telegram 生命周期分片预算不足，无法完整表示内容");
      }
      const transition = bold === desiredBold ? 0 : desiredBold ? 3 : 4;
      const closing = desiredBold ? 4 : 0;
      if (length + transition + encodedLength + closing > limit && chunk) flush();
      if (bold !== desiredBold) {
        const tag = desiredBold ? "<b>" : "</b>";
        chunk += tag;
        length += tag.length;
        bold = desiredBold;
      }
      chunk += escaped;
      length += encodedLength;
    }
  }
  flush();
  return chunks;
}

/** System title and field labels are formatted while all supplied values remain literal. */
export function formatTelegramLiteralPanelChunks(title: string, body: string, limit = 3_600): string[] {
  return splitTelegramText(`${title}\n${body}`, Math.max(1, limit - 128)).map((chunk, chunkIndex) =>
    protectTelegramReplyHeading(chunk.split("\n").map((line, lineIndex) => {
      if (chunkIndex === 0 && lineIndex === 0) return `<b>${escapeTelegramHtml(line)}</b>`;
      const field = line.match(/^([^：\n]{1,32}：)(.*)$/);
      return field
        ? `<b>${escapeTelegramHtml(field[1]!)}</b>${escapeTelegramHtml(field[2]!)}`
        : escapeTelegramHtml(line);
    }).join("\n")),
  );
}

export function formatTelegramExpandableQuotePanelChunks(
  title: string,
  detail: string,
  limit = 3_600,
): string[] {
  const titleHtml = `<b>${escapeTelegramHtml(title)}</b>`;
  const quotePrefix = "<blockquote expandable>";
  const quoteSuffix = "</blockquote>";
  const quoteOverhead = Array.from(`${quotePrefix}${quoteSuffix}`).length;
  const firstDetailLimit = Math.max(
    1,
    limit
      - Array.from(titleHtml).length
      - 2
      - quoteOverhead,
  );
  const remainingDetailLimit = Math.max(1, limit - quoteOverhead);
  const chunks = splitEscapedText(detail, firstDetailLimit, remainingDetailLimit);

  return chunks.map((chunk, index) => [
    ...(index === 0 ? [titleHtml, ""] : []),
    `${quotePrefix}${escapeTelegramHtml(chunk)}${quoteSuffix}`,
  ].join("\n"));
}

export function formatTelegramDiffChunks(text: string, limit = 3_600): string[] {
  const separator = text.indexOf("\n\n");
  if (separator < 0 || !text.startsWith("Turn Diff · ")) {
    return formatTelegramPanelChunks(text, limit);
  }

  const title = text.slice(0, separator);
  const diff = text.slice(separator + 2);
  const contentLimit = Math.max(1, limit - Array.from(title).length - 160);
  return splitTelegramText(diff, contentLimit).map((chunk, index) => [
    ...(index === 0 ? [`<b>${escapeTelegramHtml(title)}</b>`, ""] : []),
    `<pre>${escapeTelegramHtml(chunk)}</pre>`,
  ].join("\n"));
}

export function formatTelegramPanelHtml(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = advanceMarkdownFence(undefined, line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length) {
        if (advanceMarkdownFence(fence, lines[index]!) === undefined) break;
        code.push(lines[index]!);
        index += 1;
      }
      output.push(`<pre>${escapeTelegramHtml(code.join("\n"))}</pre>`);
      continue;
    }
    if (!line) {
      output.push("");
      continue;
    }

    if (line.startsWith("│ ")) {
      const quoted = [line.slice(2)];
      while (index + 1 < lines.length && lines[index + 1]!.startsWith("│ ")) {
        quoted.push(lines[index + 1]!.slice(2));
        index += 1;
      }
      output.push(`<blockquote>${escapeTelegramHtml(quoted.join("\n"))}</blockquote>`);
      continue;
    }

    const escaped = escapeTelegramHtml(line);
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(`<b>${escapeTelegramHtml(heading[1]!)}</b>`);
      continue;
    }
    const emphasis = /^\*\*([^*\n]+)\*\*( · [^\n]*)$/u.exec(line)
      ?? /^\*\*([^\n]+)\*\*$/u.exec(line);
    if (emphasis) {
      output.push(`<b>${escapeTelegramHtml(emphasis[1]!)}</b>${escapeTelegramHtml(emphasis[2] ?? "")}`);
      continue;
    }

    const bullet = line.match(/^(\s*)-\s+(.+)$/);
    if (bullet) {
      const field = bullet[2]!.match(/^([^：\n]{1,32}：)(.*)$/);
      if (field && !field[1]!.includes("**")) {
        output.push(
          `${bullet[1]}• <b>${escapeTelegramHtml(field[1]!)}</b>${escapeTelegramHtml(field[2]!)}`,
        );
      } else {
        output.push(
          `${bullet[1]}• ${escapeTelegramHtml(bullet[2]!)
            .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")}`,
        );
      }
      continue;
    }

    if (/^\s*\/[a-z][^\n]*$/i.test(line)) {
      output.push(`<code>${escaped.trimStart()}</code>`);
      continue;
    }

    if (/^\s{2,}(?:\/|[A-Za-z]:\\)/.test(line)) {
      output.push(`<code>${escaped.trimStart()}</code>`);
      continue;
    }

    // Ordered catalogue rows contain literal names and inline metadata, not a
    // field label ending at the first colon inside a user-provided name.
    if (/^\s*\d+[.)]\s+/u.test(line)) {
      output.push(escaped);
      continue;
    }

    const field = line.match(/^([^：\n]{1,32}：)(.*)$/);
    if (field) {
      const label = escapeTelegramHtml(field[1]!);
      const value = escapeTelegramHtml(field[2]!);
      const formattedValue = /^(切换|恢复|恢复归档|恢复会话)：$/.test(field[1]!)
        ? `<code>${value.trimStart()}</code>`
        : value;
      output.push(`<b>${label}</b>${formattedValue}`);
      continue;
    }

    output.push(escaped);
  }

  return protectTelegramReplyHeading(output.join("\n"));
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function splitEscapedText(
  text: string,
  firstLimit: number,
  remainingLimit: number,
): string[] {
  const remaining = Array.from(text);
  if (remaining.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  while (remaining.length > 0) {
    const limit = chunks.length === 0 ? firstLimit : remainingLimit;
    let boundary = largestEscapedPrefix(remaining, limit);
    if (boundary < remaining.length) {
      const newline = remaining.lastIndexOf("\n", boundary - 1);
      if (newline >= Math.floor(boundary / 2)) {
        boundary = newline;
      }
    }
    boundary = Math.max(1, boundary);
    chunks.push(remaining.splice(0, boundary).join(""));
    if (remaining[0] === "\n") {
      remaining.shift();
    }
  }
  return chunks;
}

function largestEscapedPrefix(characters: string[], limit: number): number {
  let low = 0;
  let high = Math.min(characters.length, limit);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const escapedLength = Array.from(escapeTelegramHtml(characters.slice(0, middle).join(""))).length;
    if (escapedLength <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}
