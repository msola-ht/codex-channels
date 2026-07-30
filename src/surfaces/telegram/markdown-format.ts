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
  return output.join("\n");
}

function formatInlineMarkdown(text: string): string {
  const protectedHtml: string[] = [];
  const protect = (html: string): string => {
    const index = protectedHtml.push(html) - 1;
    return `\uE000HTML${index}\uE001`;
  };
  const withPlaceholders = text.replace(/`([^`\n]+)`/g, (_match, content: string) => {
    const rendered = isBotCommand(content.trim())
      ? escapeHtml(content.trim())
      : `<code>${escapeHtml(content)}</code>`;
    return protect(rendered);
  }).replace(
    /(?<!!)\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi,
    (match, label: string, destination: string) => {
      if (!isSafeHttpUrl(destination)) {
        return match;
      }
      return protect(
        `<a href="${escapeHtml(destination)}">${formatInlineMarkdown(label)}</a>`,
      );
    },
  );
  const formatted = escapeHtml(withPlaceholders)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/__([^_\n]+)__/g, "<b>$1</b>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>")
    .replace(/(?<![_A-Za-z0-9])_([^_\n]+)_(?![_A-Za-z0-9])/g, "<i>$1</i>");
  return formatted.replace(
    /\uE000HTML(\d+)\uE001/g,
    (_match, index: string) => protectedHtml[Number(index)] ?? "",
  );
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
