const maximumFormattedMarkdownCharacters = 3_500;

export function formatMarkdownAsTelegramHtml(markdown: string): string | undefined {
  if (Array.from(markdown).length > maximumFormattedMarkdownCharacters) {
    return undefined;
  }

  const lines = markdown.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = line.match(/^```([a-zA-Z0-9_+-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      const language = fence[1];
      const className = language ? ` class="language-${escapeHtml(language)}"` : "";
      output.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
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
  return output.join("\n");
}

function formatInlineMarkdown(text: string): string {
  const code: string[] = [];
  const withPlaceholders = text.replace(/`([^`\n]+)`/g, (_match, content: string) => {
    const index = code.push(`<code>${escapeHtml(content)}</code>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  const formatted = escapeHtml(withPlaceholders)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
  return formatted.replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}
