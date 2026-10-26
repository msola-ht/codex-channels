import { protectTelegramReplyHeading } from "./html-format.js";
import { advanceMarkdownFence, type MarkdownFence } from "../markdown-fence.js";
import { markdownInlineCodeAt } from "../markdown-inline-code.js";

const maximumFormattedMarkdownCharacters = 3_500;
const markdownBackslashEscapePattern = /\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/gu;

export function formatMarkdownAsTelegramHtml(markdown: string): string | undefined {
  if (Array.from(markdown).length > maximumFormattedMarkdownCharacters) {
    return undefined;
  }

  return renderMarkdownAsTelegramHtml(markdown);
}

function renderMarkdownAsTelegramHtml(markdown: string): string {
  const lines = markdown.split("\n");
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
      const info = fence.info.trim().split(/\s/u, 1)[0]!;
      const language = /^[a-zA-Z0-9_+-]+$/u.test(info) ? info : undefined;
      if (
        (!language || language.toLowerCase() === "text")
        && isBotCommandBlock(code)
      ) {
        output.push(
          code
            .map((command) => escapeHtml(command.trim()))
            .join("\n"),
        );
        continue;
      }
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      output.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const tableHeader = parseMarkdownTableRow(line);
    const tableSeparator = index + 1 < lines.length
      ? parseMarkdownTableSeparator(lines[index + 1]!)
      : undefined;
    if (
      tableHeader
      && tableSeparator
      && tableHeader.length === tableSeparator.length
    ) {
      output.push(`<b>${tableHeader.map(formatInlineMarkdown).join(" · ")}</b>`);
      index += 1;
      while (index + 1 < lines.length) {
        const row = parseMarkdownTableRow(lines[index + 1]!);
        if (!row || row.length !== tableHeader.length) {
          break;
        }
        output.push(`• ${row.map(formatInlineMarkdown).join(" · ")}`);
        index += 1;
      }
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      output.push(`<b>${formatInlineMarkdown(heading[1]!)}</b>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const quoted: string[] = [quote[1]!];
      while (index + 1 < lines.length) {
        const next = lines[index + 1]!.match(/^>\s?(.*)$/);
        if (!next) {
          break;
        }
        quoted.push(next[1]!);
        index += 1;
      }
      output.push(`<blockquote>${quoted.map(formatInlineMarkdown).join("\n")}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      output.push(`• ${formatInlineMarkdown(bullet[1]!)}`);
      continue;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    if (ordered) {
      output.push(`${ordered[1]}. ${formatInlineMarkdown(ordered[2]!)}`);
      continue;
    }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) {
      output.push("────────");
      continue;
    }

    output.push(formatInlineMarkdown(line));
  }
  return protectTelegramReplyHeading(output.join("\n"));
}

function formatInlineMarkdown(text: string): string {
  const protectedHtml: string[] = [];
  let placeholderPrefix = "\uE000HTML";
  while (text.includes(placeholderPrefix)) placeholderPrefix += "\uE002";
  const protect = (html: string): string => {
    const index = protectedHtml.push(html) - 1;
    return `${placeholderPrefix}${index}\uE001`;
  };
  let withPlaceholders = "";
  for (let index = 0; index < text.length;) {
    const escaped = text[index] === "\\"
      ? /^\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/u.exec(text.slice(index))
      : null;
    if (escaped) {
      withPlaceholders += protect(escapeHtml(escaped[1]!));
      index += escaped[0].length;
      continue;
    }
    if (text[index] === "`") {
      const code = markdownInlineCodeAt(text, index);
      withPlaceholders += protect(code.content === undefined
        ? escapeHtml(text.slice(index, code.end))
        : isBotCommand(code.content.trim())
          ? escapeHtml(code.content.trim())
          : `<code>${escapeHtml(code.content)}</code>`);
      index = code.end;
      continue;
    }
    if (text[index] === "[" && text[index - 1] !== "!") {
      const link = markdownLinkAt(text, index);
      if (link) {
        const destination = link.destination.replace(markdownBackslashEscapePattern, "$1");
        if (destination.startsWith("/") && !destination.startsWith("//")) {
          const reference = destination.slice(destination.lastIndexOf("/") + 1);
          if (reference) {
            withPlaceholders += protect(`<code>${escapeHtml(reference)}</code>`);
            index = link.end;
            continue;
          }
        } else if (/^https?:\/\//iu.test(destination) && isSafeHttpUrl(destination)) {
          withPlaceholders += protect(
            `<a href="${escapeHtml(destination)}">${formatInlineMarkdown(link.label)}</a>`,
          );
          index = link.end;
          continue;
        }
      }
    }
    withPlaceholders += text[index];
    index += 1;
  }
  const formatted = escapeHtml(withPlaceholders)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/(?<![_A-Za-z0-9])_([^_\n]+)_(?![_A-Za-z0-9])/g, "<i>$1</i>");
  return formatted.replace(
    new RegExp(`${placeholderPrefix}(\\d+)\uE001`, "g"),
    (_match, index: string) => protectedHtml[Number(index)] ?? "",
  );
}

function markdownLinkAt(text: string, start: number): {
  label: string;
  destination: string;
  end: number;
} | undefined {
  let cursor = start + 1;
  while (cursor < text.length && text[cursor] !== "\n") {
    if (text[cursor] === "\\") {
      cursor += 2;
    } else if (text[cursor] === "`") {
      cursor = markdownInlineCodeAt(text, cursor).end;
    } else if (text[cursor] === "]") {
      break;
    } else {
      cursor += 1;
    }
  }
  if (cursor === start + 1 || text[cursor] !== "]" || text[cursor + 1] !== "(") return undefined;
  const label = text.slice(start + 1, cursor);
  const destinationStart = cursor + 2;
  const wrapped = text[destinationStart] === "<";
  cursor = destinationStart + (wrapped ? 1 : 0);
  const contentStart = cursor;
  let parentheses = 0;
  while (cursor < text.length && text[cursor] !== "\n") {
    if (text[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (wrapped) {
      if (text[cursor] === ">") break;
    } else {
      if (/\s/u.test(text[cursor]!)) break;
      if (text[cursor] === "(") parentheses += 1;
      if (text[cursor] === ")") {
        if (parentheses === 0) break;
        parentheses -= 1;
      }
    }
    cursor += 1;
  }
  if (cursor === contentStart || (wrapped ? text[cursor] !== ">" || text[cursor + 1] !== ")" : text[cursor] !== ")")) {
    return undefined;
  }
  return {
    label,
    destination: text.slice(contentStart, cursor),
    end: cursor + (wrapped ? 2 : 1),
  };
}

export function decodeMarkdownBackslashEscapes(markdown: string): string {
  const lines = markdown.split("\n");
  let fence: MarkdownFence | undefined;
  return lines.map((line) => {
    const previous = fence;
    fence = advanceMarkdownFence(fence, line);
    return previous || fence ? line : decodeInlineMarkdownBackslashEscapes(line);
  }).join("\n");
}

function decodeInlineMarkdownBackslashEscapes(text: string): string {
  let output = "";
  for (let index = 0; index < text.length;) {
    if (text[index] === "\\") {
      const escaped = /^\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/u.exec(text.slice(index));
      if (escaped) {
        output += escaped[1];
        index += 2;
        continue;
      }
    }
    if (text[index] === "`") {
      const code = markdownInlineCodeAt(text, index);
      output += text.slice(index, code.end);
      index = code.end;
      continue;
    }
    output += text[index];
    index += 1;
  }
  return output;
}

function parseMarkdownTableRow(line: string): string[] | undefined {
  if (!line.includes("|")) {
    return undefined;
  }
  const trimmed = line.trim().replace(/^\|/u, "").replace(/\|$/u, "");
  const cells = trimmed.split("|").map((cell) => cell.trim());
  return cells.length >= 2 && cells.every(Boolean) ? cells : undefined;
}

function parseMarkdownTableSeparator(line: string): string[] | undefined {
  const cells = parseMarkdownTableRow(line);
  return cells?.every((cell) => /^:?-{3,}:?$/u.test(cell))
    ? cells
    : undefined;
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isBotCommandBlock(lines: readonly string[]): boolean {
  const commands = lines.map((line) => line.trim()).filter(Boolean);
  return commands.length > 0 && commands.every(isBotCommand);
}

function isBotCommand(value: string): boolean {
  return /^\/[a-z][a-z0-9_]*(?:@[a-z0-9_]+)?(?:\s+.*)?$/i.test(value);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

/** Split rendered HTML after parsing entities, reopening formatting across message boundaries. */
export function formatMarkdownAsTelegramHtmlChunks(markdown: string): string[] {
  const html = renderMarkdownAsTelegramHtml(markdown);
  const chunks: string[] = [];
  const open: Array<{ tag: string; html: string }> = [];
  let current = "";
  let visibleLength = 0;
  const flush = (): void => {
    if (visibleLength === 0) return;
    chunks.push(protectTelegramReplyHeading(current + [...open].reverse().map((entry) => `</${entry.tag}>`).join("")));
    current = open.map((entry) => entry.html).join("");
    visibleLength = 0;
  };
  for (const match of html.matchAll(/<[^>]*>|&(?:amp|lt|gt|quot|#39);|[\s\S]/gu)) {
    const token = match[0];
    if (token.startsWith("<")) {
      const tag = token.match(/^<(\/?)([a-z]+)/u);
      if (tag?.[1]) open.pop();
      else if (tag) open.push({ tag: tag[2]!, html: token });
      current += token;
      continue;
    }
    const size = token.startsWith("&") ? 1 : token.length;
    if (visibleLength + size > 3_500) flush();
    current += token;
    visibleLength += size;
    if (token === "\n" && visibleLength >= 2_800) flush();
  }
  flush();
  return chunks;
}

/** 仅用于本模块生成的 HTML 分片降级，先去标签再解码，避免误删正文里的尖括号。 */
export function telegramHtmlToPlainText(html: string, options?: { preserveUrls?: boolean }): string {
  const withUrls = options?.preserveUrls
    ? html.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/gu, (_match, destination: string, label: string) =>
      `${label} (${destination})`)
    : html;
  return withUrls.replace(/<[^>]*>/gu, "").replace(/&(amp|lt|gt|quot|#39);/gu, (_match, entity: string) => {
    const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
    return entities[entity]!;
  });
}
