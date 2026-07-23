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
    const rendered = isBotCommand(content.trim())
      ? escapeHtml(content.trim())
      : `<code>${escapeHtml(content)}</code>`;
    const index = code.push(rendered) - 1;
    return `\uE000CODE${index}\uE001`;
  });
  const formatted = escapeHtml(withPlaceholders)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
  return formatted.replace(/\uE000CODE(\d+)\uE001/g, (_match, index: string) => code[Number(index)] ?? "");
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
