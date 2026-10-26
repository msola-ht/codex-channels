import { advanceMarkdownFence } from "../markdown-fence.js";
import { markdownInlineCodeAt } from "../markdown-inline-code.js";

export function formatWeixinFinalText(text: string): string {
  const lines = text.split(/\r?\n/u);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const opening = lines[index]!;
    const fence = advanceMarkdownFence(undefined, opening);
    if (!fence) {
      output.push(formatWeixinMarkdownLine(opening));
      continue;
    }
    const closingIndex = lines.findIndex(
      (line, candidate) =>
        candidate > index && advanceMarkdownFence(fence, line) === undefined,
    );
    if (closingIndex < 0) {
      // An unclosed fence creates an oversized, unterminated code region in
      // Weixin. Drop only the fence marker and keep formatting the body as
      // ordinary text.
      continue;
    }
    const code = lines.slice(index + 1, closingIndex);
    if (
      code.length === 1
      && code[0]!.trim().length > 0
      && !code[0]!.includes("`")
    ) {
      output.push(`\`${code[0]}\``);
      index = closingIndex;
      continue;
    }
    output.push(...lines.slice(index, closingIndex + 1));
    index = closingIndex;
  }
  return output.join("\n");
}

function formatWeixinMarkdownLine(line: string): string {
  const smallHeading = /^#{5,6}[ \t]+(.+)$/u.exec(line);
  const value = smallHeading === null ? line : `**${smallHeading[1]}**`;
  return formatWeixinMarkdownInline(value);
}

interface InlineFormatBudget { remaining: number }

function formatWeixinMarkdownInline(
  value: string,
  depth = 0,
  budget: InlineFormatBudget = { remaining: Math.max(1_024, value.length * 8) },
): string {
  // Link labels are untrusted model output. Preserve deeply nested text rather
  // than exhausting the stack before the Outbox can send its preview or file.
  if (depth >= 32) return value;
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (budget.remaining-- <= 0) return output + value.slice(index);
    if (value[index] === "\\" && isMarkdownPunctuation(value[index + 1])) {
      output += value.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (value[index] === "`") {
      const code = boundedInlineCodeAt(value, index, budget);
      output += value.slice(index, code.end);
      index = code.end;
      continue;
    }

    if (value.startsWith("![", index)) {
      const image = markdownLinkAt(value, index + 2, budget);
      if (image !== null) {
        index = image.end;
        continue;
      }
    }

    if (value[index] === "[") {
      const link = markdownLinkAt(value, index + 1, budget);
      if (link !== null) {
        output += `[${formatWeixinMarkdownInline(value.slice(index + 1, link.labelEnd), depth + 1, budget)}${value.slice(link.labelEnd, link.end)}`;
        index = link.end;
        continue;
      }
    }

    const emphasis = cjkEmphasisAt(value, index, depth, budget);
    if (emphasis !== null) {
      output += emphasis.text;
      index = emphasis.end;
      continue;
    }

    output += value[index];
    index += 1;
  }
  return output;
}

function boundedInlineCodeAt(value: string, start: number, budget: InlineFormatBudget): { end: number } {
  if (value.length - start > budget.remaining) {
    budget.remaining = 0;
    return { end: value.length };
  }
  const code = markdownInlineCodeAt(value, start);
  budget.remaining -= (code.content === undefined ? value.length : code.end) - start;
  return code;
}

function markdownLinkAt(
  value: string,
  labelStart: number,
  budget: InlineFormatBudget,
): { labelEnd: number; end: number } | null {
  let cursor = labelStart;
  let brackets = 1;
  while (cursor < value.length) {
    if (budget.remaining-- <= 0) return null;
    if (value[cursor] === "\\" && isMarkdownPunctuation(value[cursor + 1])) {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "`") {
      cursor = boundedInlineCodeAt(value, cursor, budget).end;
      continue;
    }
    if (value[cursor] === "[") brackets += 1;
    if (value[cursor] === "]" && --brackets === 0) break;
    cursor += 1;
  }
  if (brackets !== 0 || value[cursor + 1] !== "(") return null;
  const labelEnd = cursor;
  cursor += 2;
  while (/[ \t]/u.test(value[cursor] ?? "")) {
    if (budget.remaining-- <= 0) return null;
    cursor += 1;
  }
  const wrapped = value[cursor] === "<";
  if (wrapped) cursor += 1;
  let parentheses = 0;
  while (cursor < value.length) {
    if (budget.remaining-- <= 0) return null;
    if (value[cursor] === "\\" && isMarkdownPunctuation(value[cursor + 1])) {
      cursor += 2;
      continue;
    }
    if (wrapped) {
      if (value[cursor] === ">") break;
      if (value[cursor] === "<") return null;
    } else {
      if (/\s/u.test(value[cursor]!)) break;
      if (value[cursor] === "<") return null;
      if (value[cursor] === "(") parentheses += 1;
      if (value[cursor] === ")") {
        if (parentheses === 0) break;
        parentheses -= 1;
      }
    }
    cursor += 1;
  }
  if (parentheses !== 0 || (wrapped && value[cursor++] !== ">")) return null;
  const destinationEnd = cursor;
  while (/[ \t]/u.test(value[cursor] ?? "")) {
    if (budget.remaining-- <= 0) return null;
    cursor += 1;
  }
  if (cursor > destinationEnd && (value[cursor] === '"' || value[cursor] === "'" || value[cursor] === "(")) {
    const closing = value[cursor] === "(" ? ")" : value[cursor];
    cursor += 1;
    while (cursor < value.length && value[cursor] !== closing) {
      if (budget.remaining-- <= 0) return null;
      if (value[cursor] === "\\" && isMarkdownPunctuation(value[cursor + 1])) cursor += 2;
      else if (closing === ")" && value[cursor] === "(") return null;
      else cursor += 1;
    }
    if (value[cursor++] !== closing) return null;
    while (/[ \t]/u.test(value[cursor] ?? "")) {
      if (budget.remaining-- <= 0) return null;
      cursor += 1;
    }
  }
  return value[cursor] === ")" ? { labelEnd, end: cursor + 1 } : null;
}

function cjkEmphasisAt(
  value: string,
  start: number,
  depth: number,
  budget: InlineFormatBudget,
): { text: string; end: number } | null {
  const markers = ["***", "___", "*", "_"] as const;
  for (const marker of markers) {
    if (!value.startsWith(marker, start)) {
      continue;
    }
    if (
      marker.length === 1
      && (
        value.startsWith(marker.repeat(2), start)
        || value[start - 1] === marker
      )
    ) {
      continue;
    }
    const contentStart = start + marker.length;
    const closing = emphasisClosingAt(value, contentStart, marker, budget);
    if (closing <= contentStart) {
      continue;
    }
    if (
      marker === "_"
      && (
        isWordCharacter(value[start - 1])
        || isWordCharacter(value[closing + 1])
      )
    ) {
      continue;
    }
    const content = value.slice(contentStart, closing);
    if (!containsCjk(content)) {
      return null;
    }
    return {
      text: formatWeixinMarkdownInline(content, depth + 1, budget),
      end: closing + marker.length,
    };
  }
  return null;
}

function emphasisClosingAt(value: string, start: number, marker: string, budget: InlineFormatBudget): number {
  for (let index = start; index < value.length; index += 1) {
    if (budget.remaining-- <= 0) return -1;
    if (value[index] === "\\" && isMarkdownPunctuation(value[index + 1])) {
      index += 1;
    } else if (value[index] === "`") {
      index = boundedInlineCodeAt(value, index, budget).end - 1;
    } else if (value[index] === "[") {
      const link = markdownLinkAt(value, index + 1, budget);
      if (link !== null) index = link.end - 1;
    } else if (value[index] === marker[0]) {
      let end = index + 1;
      while (value[end] === marker[0]) {
        if (budget.remaining-- <= 0) return -1;
        end += 1;
      }
      if (end - index === marker.length) return index;
      index = end - 1;
    }
  }
  return -1;
}

function isMarkdownPunctuation(value: string | undefined): boolean {
  return value !== undefined && /[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]/u.test(value);
}

function containsCjk(value: string): boolean {
  return /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/u.test(value);
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}
